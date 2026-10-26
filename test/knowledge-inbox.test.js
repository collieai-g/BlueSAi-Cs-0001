import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store } from '../src/store.js';
import { Engine, normalizeFaqQuestion } from '../src/engine.js';

function fixture(t, { enabled = true, automatic = true, delivery = true } = {}) {
  const store = new Store(':memory:');
  const sent = []; let modelCalls = 0;
  const agent = { configured: false, async reply() { modelCalls++; throw Error('A model must never be called in knowledge mode'); } };
  const provider = { configured: true, deliveryEnabled: delivery, instance: 'fixture-channel', async send(address,text) { sent.push({address,text}); return {providerId:'test-'+sent.length}; } };
  const engine = new Engine(store, agent, provider);
  store.set('profile', {name:'測試商戶',industry:'',service:'測試服務',instructions:'',tone:'friendly'});
  store.set('settings', {mode:'review',handoffContact:'由本卡片人工接手'});
  engine.configureInbox({enabled,automaticKnowledge:automatic});
  t.after(async()=>{await engine.stop();store.close();});
  return {store,engine,sent,provider,calls:()=>modelCalls,
    incoming:(text,extra={})=>engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',name:'測試客戶',text,...extra})};
}

test('an explicitly approved exact FAQ is queued immediately and sent without any model invocation',async t=>{
  const f=fixture(t);
  const rule=f.engine.addFaq({question:'營業時間是甚麼？',answer:'星期一至五上午十時至下午六時。',approved:true});
  const r=f.incoming('營業時間是甚麼?');
  const answer=f.store.messages(r.conversationId).at(-1);
  assert.equal(answer.status,'queued'); assert.equal(answer.engine,'knowledge');
  assert.deepEqual(answer.sources,[rule.knowledgeId]);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
  await f.engine.tick();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].text,'星期一至五上午十時至下午六時。');
  assert.equal(f.calls(),0); assert.equal(f.engine.inboxStatus().pendingCount,0);
});

test('question normalization is conservative and never matches a partial or numeric near-match',t=>{
  const f=fixture(t);
  assert.equal(normalizeFaqQuestion('  ＡＢＣ  1.5？ '),'abc 1.5');
  assert.notEqual(normalizeFaqQuestion('產品 1.5'),normalizeFaqQuestion('產品 15'));
  f.engine.addFaq({question:'產品 1.5 幾錢',answer:'HK$120',approved:true});
  const r=f.incoming('產品 15 幾錢？');
  assert.equal(f.store.messages(r.conversationId).length,1);
  assert.equal(f.engine.inboxStatus().pending[0].reason,'knowledge_missing');
  assert.equal(f.calls(),0);
});

test('missing answers immediately create one durable local notice with no AI job or false external alert',async t=>{
  const f=fixture(t);
  const r=f.incoming('是否有未列出的服務？',{eventId:'same-event'});
  assert.equal(f.store.conversation(r.conversationId).state,'waiting');
  assert.equal(f.incoming('是否有未列出的服務？',{eventId:'same-event'}).duplicate,true);
  const status=f.engine.inboxStatus();
  assert.equal(status.pendingCount,1); assert.equal(status.pending[0].conversationId,r.conversationId);
  assert.deepEqual(status.notification,{scope:'local_card',externalNotified:false});
  assert.doesNotMatch(JSON.stringify(status),/85255550001|未列出的服務/);
  await f.engine.tick();
  assert.equal(f.calls(),0); assert.equal(f.sent.length,0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM response_windows WHERE status='pending'").n,0);
  f.engine.takeover(r.conversationId);
  assert.equal(f.engine.inboxStatus().pendingCount,1);
  f.engine.manualReply(r.conversationId,'我會跟進。');
  assert.equal(f.engine.inboxStatus().pendingCount,0);
  assert.equal(f.store.get('SELECT status FROM handoff_tasks WHERE conversation_id=?',r.conversationId).status,'handled');
});

test('pending, expired, conflicting and refund answers all hand off rather than guess or call a model',t=>{
  const f=fixture(t);
  f.engine.addFaq({question:'待確認問題',answer:'未批准答案',approved:false});
  const expired=f.engine.addFaq({question:'過期問題',answer:'過期答案',approved:true});
  f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?',Date.now()-1,expired.knowledgeId);
  f.engine.addFaq({question:'衝突問題',answer:'答案甲',approved:true});
  f.engine.addFaq({question:'衝突問題',answer:'答案乙',approved:true});
  f.engine.addFaq({question:'可以批准退款嗎',answer:'批准退款',approved:true});
  const scenarios=[['待確認問題','knowledge_missing'],['過期問題','knowledge_missing'],['衝突問題','knowledge_conflict'],['可以批准退款嗎','knowledge_requires_human']];
  for(let i=0;i<scenarios.length;i++){
    const [text,reason]=scenarios[i],r=f.incoming(text,{address:`8525555000${i+2}@s.whatsapp.net`});
    assert.equal(f.store.messages(r.conversationId).length,1);
    assert.equal(f.engine.inboxStatus().pending.find(x=>x.conversationId===r.conversationId).reason,reason);
  }
  assert.equal(f.calls(),0); assert.equal(f.sent.length,0);
  assert.equal(f.engine.listFaq().find(x=>x.id===expired.id).usable,false);
});

test('closed channel gate and review-only policy save sourced drafts without transmitting',async t=>{
  const f=fixture(t,{delivery:false});
  f.engine.addFaq({question:'有甚麼服務',answer:'已確認服務內容',approved:true});
  const r=f.incoming('有甚麼服務');
  assert.equal(f.store.messages(r.conversationId).at(-1).status,'draft');
  await f.engine.tick(); assert.equal(f.sent.length,0);
  f.provider.deliveryEnabled=true;
  f.engine.configureInbox({enabled:true,automaticKnowledge:false});
  const next=f.incoming('有甚麼服務',{address:'85255550002@s.whatsapp.net'});
  assert.equal(f.store.messages(next.conversationId).at(-1).status,'draft');
  assert.equal(f.calls(),0);
});

test('model-free knowledge and manual replies preserve blank merchant fields while enforcing channel readiness',async t=>{
  const f=fixture(t);
  const profile={name:'',industry:'',service:'',instructions:'',tone:'friendly'};
  const settings={mode:'review',handoffContact:''};
  f.store.set('profile',profile);f.store.set('settings',settings);
  assert.equal(f.engine.liveReady(),true);
  f.engine.addFaq({question:'目前可以留言嗎',answer:'可以，請在此留言。',approved:true});
  const r=f.incoming('目前可以留言嗎');
  await f.engine.tick();assert.equal(f.sent.length,1);
  f.engine.takeover(r.conversationId);
  f.engine.manualReply(r.conversationId,'我在這裡。');await f.engine.tick();
  assert.equal(f.sent.length,2);
  assert.deepEqual(f.store.value('profile'),profile);assert.deepEqual(f.store.value('settings'),settings);
  f.provider.deliveryEnabled=false;
  assert.equal(f.engine.liveReady(),false);
  assert.throws(()=>f.engine.manualReply(r.conversationId,'不應發送'),/真實發送/);
  f.provider.deliveryEnabled=true;f.provider.configured=false;
  assert.equal(f.engine.liveReady(),false);
  assert.throws(()=>f.engine.manualReply(r.conversationId,'不應發送'),/真實發送/);
  f.provider.configured=true;f.engine.configureInbox({enabled:false,automaticKnowledge:false});
  assert.equal(f.engine.liveReady(),false);
  assert.equal(f.calls(),0);
});

test('human takeover stays final while replies, approved facts and conversation versions change',async t=>{
  const f=fixture(t);
  const rule=f.engine.addFaq({question:'在哪裡取貨',answer:'請在指定門市取貨。',approved:true});
  const r=f.incoming('在哪裡取貨');
  f.engine.takeover(r.conversationId);
  await f.engine.tick(); assert.equal(f.sent.length,0);
  f.incoming('在哪裡取貨');
  assert.equal(f.store.conversation(r.conversationId).state,'human');
  assert.equal(f.store.messages(r.conversationId).filter(m=>m.engine==='knowledge').length,1);
  f.engine.manualReply(r.conversationId,'請等我核對。');await f.engine.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'請等我核對。');
  f.engine.takeover(r.conversationId,'ai');
  f.incoming('在哪裡取貨');
  f.store.run('UPDATE knowledge SET approved=0 WHERE id=?',rule.knowledgeId);
  await f.engine.tick(); assert.equal(f.sent.length,1);
  assert.equal(f.calls(),0);
});

test('switching a pending model job to knowledge mode immediately hands off and ignores its late answer',async t=>{
  const f=fixture(t,{enabled:false});
  let release;
  f.engine.agent={configured:true,reply:()=>new Promise(resolve=>{release=resolve;})};
  const r=f.incoming('未有答案');
  const processing=f.engine.tick();
  await new Promise(resolve=>setImmediate(resolve));
  try{
    f.engine.configureInbox({enabled:true,automaticKnowledge:true});
    assert.equal(f.engine.inboxStatus().pendingCount,1);
  }finally{
    release({text:'晚來模型答案',decision:'answer',sourceIds:[],engine:'mock'});
    await processing;
  }
  assert.equal(f.store.messages(r.conversationId).length,1);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM jobs WHERE state='pending'").n,0);
  assert.equal(f.sent.length,0);
});

test('an edited source revision or newer incoming question invalidates a queued knowledge answer',async t=>{
  const f=fixture(t);
  f.engine.addFaq({question:'問題一',answer:'答案一',approved:true});
  const first=f.incoming('問題一');
  const answer=f.store.messages(first.conversationId).at(-1);
  f.incoming('另一個未知問題');
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',answer.id).status,'cancelled');
  await f.engine.tick(); assert.equal(f.sent.length,0);
  const next=f.incoming('問題一',{address:'85255550002@s.whatsapp.net'});
  const queued=f.store.messages(next.conversationId).at(-1);
  f.store.revise();await f.engine.tick();
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',queued.id).status,'cancelled');
  assert.equal(f.sent.length,0);
});

test('schema five is additive and preserves legacy data, policy and local handoff across restart',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'bluesai-inbox-')),path=join(dir,'service.sqlite');
  t.after(()=>{const actual=realpathSync(dir);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('bluesai-inbox-'));rmSync(actual,{recursive:true});});
  let store=new Store(path);
  const profile=store.value('profile');
  store.db.exec('DROP TABLE faq_rules;DELETE FROM schema_migrations WHERE version=5;');
  store.close();
  store=new Store(path);let engine=new Engine(store,{configured:false,reply:()=>{throw Error('no model');}},{});
  assert.deepEqual(store.value('profile'),profile);
  assert.equal(store.get('SELECT MAX(version) AS n FROM schema_migrations').n,5);
  engine.configureInbox({enabled:true,automaticKnowledge:true});
  engine.addFaq({question:'保留問題',answer:'保留答案',approved:true});
  const r=engine.receive({text:'未知問題'});
  await engine.stop();store.close();
  store=new Store(path);engine=new Engine(store,{configured:false},{});
  try{
    assert.equal(engine.listFaq()[0].answer,'保留答案');
    assert.equal(engine.inboxStatus().pending[0].conversationId,r.conversationId);
    assert.deepEqual(engine.inboxPolicy(),{enabled:true,automaticKnowledge:true,aiFallback:false,automaticAi:false});
    assert.equal(store.messages(r.conversationId).length,1);
  }finally{await engine.stop();store.close();}
});

test('store live hints coalesce synchronous writes and stop after unsubscribe or close',async()=>{
  const store=new Store(':memory:');let count=0;
  const stop=store.subscribe((...args)=>{assert.equal(args.length,0);count++;});
  store.transaction(()=>{store.set('revision',2);store.set('revision',3);});
  await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(count,1);stop();
  store.set('revision',4);await new Promise(resolve=>queueMicrotask(resolve));assert.equal(count,1);
  store.subscribe(()=>{throw Error('listener failure cannot break storage');});
  store.set('revision',5);store.close();await new Promise(resolve=>queueMicrotask(resolve));
});
