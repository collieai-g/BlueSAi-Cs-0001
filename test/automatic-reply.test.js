import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const factId='fixture-approved-product';
const answer={text:'已確認產品的價格是 HK$120。',decision:'answer',sourceIds:[factId],engine:'codex-cli'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Generation did not settle after cancellation')),1000);})]);}finally{clearTimeout(timer);}}

function fixture(t,{reply=async()=>answer,automaticAi=false,automaticKnowledge=false,delivery=true,engineOptions={}}={}){
  const store=new Store(':memory:'),calls=[],sent=[];
  store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)',factId,'合成測試產品資料','general',answer.text,1,null,Date.now());
  const agent={configured:true,provider:'codex-cli',reply(input,options){calls.push({input,signal:options.signal});return reply(input,options);}};
  const provider={configured:true,deliveryEnabled:delivery,instance:'synthetic-native-fixture',async send(address,text){sent.push({address,text});return {providerId:'fixture-'+sent.length};}};
  const engine=new Engine(store,agent,provider,engineOptions);
  engine.configureInbox({enabled:true,automaticKnowledge,aiFallback:true,automaticAi});
  t.after(async()=>{await engine.stop();store.close();});
  return {store,engine,agent,provider,calls,sent,incoming:(text,extra={})=>engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',text,...extra})};
}

test('AI policy is explicit, rejects inconsistent or unavailable activation, and preserves omitted flags from older clients',t=>{
  const store=new Store(':memory:'),engine=new Engine(store,{configured:false},{});
  t.after(async()=>{await engine.stop();store.close();});
  store.set('inbox_policy',{enabled:true,automaticKnowledge:false});
  assert.deepEqual(engine.inboxPolicy(),{enabled:true,automaticKnowledge:false,aiFallback:false,automaticAi:false});
  assert.throws(()=>engine.configureInbox({enabled:true,automaticKnowledge:false,aiFallback:true}),error=>error.status===409);
  engine.agent={configured:true};
  assert.throws(()=>engine.configureInbox({enabled:false,automaticKnowledge:false,aiFallback:true}));
  assert.throws(()=>engine.configureInbox({enabled:true,automaticKnowledge:false,automaticAi:true}));
  assert.throws(()=>engine.configureInbox({enabled:true,automaticKnowledge:false,aiFallback:'true'}));
  engine.configureInbox({enabled:true,automaticKnowledge:false,aiFallback:true,automaticAi:true});
  engine.configureInbox({enabled:true,automaticKnowledge:true});
  assert.deepEqual(engine.inboxPolicy(),{enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
  assert.equal(store.value('profile').name,'');
  assert.equal(store.get('SELECT MAX(version) AS n FROM schema_migrations').n,5);
});

test('connecting native Codex cannot inherit the legacy automatic route before explicit FAQ-first AI opt-in',async t=>{
  const store=new Store(':memory:');let calls=0,sends=0;
  const engine=new Engine(store,{configured:true,provider:'codex-cli',async reply(){calls++;return answer;}},
    {configured:true,deliveryEnabled:true,async send(){sends++;return {providerId:'not-allowed'};}});
  t.after(async()=>{await engine.stop();store.close();});
  store.set('profile',{name:'合成商戶',service:'合成服務',instructions:'',tone:'friendly'});
  store.set('settings',{mode:'auto',handoffContact:'本機測試'});
  const r=engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',text:'原生接駁後的合成問題'});
  await engine.tick();assert.equal(calls,0);assert.equal(sends,0);
  assert.equal(store.conversation(r.conversationId).state,'waiting');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
  assert.equal(store.messages(r.conversationId).filter(m=>m.role==='assistant').length,0);
});

test('FAQ remains first and unknown input gets one isolated background generation without enabling automatic delivery',async t=>{
  const f=fixture(t);
  f.engine.addFaq({question:'產品價格',answer:answer.text,approved:true});
  const known=f.incoming('產品價格');await f.engine.tick();
  assert.equal(f.calls.length,0);assert.equal(f.store.messages(known.conversationId).at(-1).engine,'knowledge');
  f.incoming('另一位客戶的私事',{address:'85255550002@s.whatsapp.net',review:true});
  const unknown=f.incoming('我想了解這件產品的價格',{eventId:'deduplicated-question'});
  assert.equal(f.incoming('我想了解這件產品的價格',{eventId:'deduplicated-question'}).duplicate,true);
  await f.engine.tick();
  assert.equal(f.calls.length,1);
  assert.doesNotMatch(JSON.stringify(f.calls[0].input),/另一位客戶的私事|85255550002/);
  assert.equal(f.store.messages(unknown.conversationId).at(-1).status,'draft');
  assert.equal(f.sent.length,0);assert.equal(f.engine.inboxStatus().pendingCount,1);
});

test('AI automatic delivery is independent of the FAQ switch and still requires a sourced answer and channel gate',async t=>{
  const f=fixture(t,{automaticAi:true});
  f.engine.addFaq({question:'完整問題',answer:'已批准 FAQ 原文。',approved:true});
  const known=f.incoming('完整問題',{address:'85255550002@s.whatsapp.net'});
  assert.equal(f.store.messages(known.conversationId).at(-1).status,'draft');
  const generated=f.incoming('請解釋已確認的產品價格');await f.engine.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,answer.text);
  assert.equal(f.store.messages(generated.conversationId).at(-1).status,'accepted');
  f.provider.deliveryEnabled=false;
  const blocked=f.incoming('請再解釋產品價格',{address:'85255550003@s.whatsapp.net'});await f.engine.tick();
  assert.equal(f.store.messages(blocked.conversationId).at(-1).status,'draft');
  assert.equal(f.sent.length,1);
  assert.equal(f.store.value('profile').name,'');assert.equal(f.store.value('settings').handoffContact,'');
});

test('human requests, refunds, exceptions, conflicts and reviewed ingress never enter AI fallback',async t=>{
  const f=fixture(t,{automaticAi:true});
  f.engine.addFaq({question:'互相矛盾',answer:'合成答案甲。',approved:true});
  f.engine.addFaq({question:'互相矛盾',answer:'合成答案乙。',approved:true});
  for(const [i,text] of ['要求人工','批准退款','想作例外安排','互相矛盾','舊訊息'].entries()){
    const r=f.incoming(text,{address:`8525555010${i}@s.whatsapp.net`,review:i===4});
    assert.equal(f.store.conversation(r.conversationId).state,'waiting');
  }
  await f.engine.tick();assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
});

test('clarifications stay drafts; handoffs, unsupported sources and false action claims cannot automatically send',async t=>{
  const cases=[
    [{text:'請問是哪款產品？',decision:'clarify',sourceIds:[]},'ai','draft'],
    [{text:'需要由本人核對。',decision:'handoff',sourceIds:[]},'waiting','draft'],
    [{...answer,sourceIds:['invented-id']},'waiting','failed'],
    [{...answer,sourceIds:[]},'waiting','failed'],
    [{...answer,text:'已退款。'},'waiting','draft'],
  ];
  for(const [result,state,status] of cases){
    const f=fixture(t,{automaticAi:true,reply:async()=>result});const r=f.incoming('請解釋產品');await f.engine.tick();
    assert.equal(f.store.conversation(r.conversationId).state,state);
    assert.equal(f.store.messages(r.conversationId).at(-1).status,status);
    assert.equal(f.sent.length,0);
  }
});

test('an AI answer citing refund knowledge becomes a local handoff even without a refund keyword in the incoming text',async t=>{
  const modelText='可以安排退回九成款項。';
  const f=fixture(t,{automaticAi:true,reply:async()=>({...answer,text:modelText})});
  f.store.run("UPDATE knowledge SET category='refund' WHERE id=?",factId);
  const r=f.incoming('可唔可以退回九成款項？');await f.engine.tick();
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  assert.equal(f.store.conversation(r.conversationId).state,'waiting');
  const response=f.store.messages(r.conversationId).at(-1);
  assert.equal(response.decision,'handoff');assert.equal(response.status,'draft');
  assert.notEqual(response.content,modelText);assert.deepEqual(response.sources,[]);
  assert.equal(f.engine.inboxStatus().pending[0].reason,'knowledge_requires_human');
  assert.throws(()=>f.engine.approve(response.id,response.content),error=>error.status===409);
});

test('dispatch blocks refund sources reclassified after automatic queuing or explicit draft approval',async t=>{
  for(const automaticAi of [false,true]){
    const f=fixture(t,{automaticAi}),r=f.incoming('請解釋產品安排');
    await f.engine.processJob(f.store.get('SELECT * FROM jobs WHERE id=?',r.messageId));
    const response=f.store.messages(r.conversationId).at(-1);
    assert.equal(response.status,automaticAi?'queued':'draft');
    if(!automaticAi)f.engine.approve(response.id,response.content);
    assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',response.id).status,'queued');
    // Omit revise() deliberately: dispatch must enforce the current category
    // itself, beyond the ordinary knowledge-edit revision cancellation.
    f.store.run("UPDATE knowledge SET category='refund' WHERE id=?",factId);
    await f.engine.dispatch(response);
    assert.equal(f.sent.length,0);
    assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',response.id).status,'cancelled');
    assert.equal(f.store.conversation(r.conversationId).state,'waiting');
    assert.equal(f.engine.inboxStatus().pending[0].reason,'knowledge_requires_human');
  }
});

test('takeover cancels an ignoring adapter, preserves immediate manual delivery and rejects its late result',async t=>{
  const pending=deferred(),f=fixture(t,{automaticAi:true,reply:()=>pending.promise});
  const r=f.incoming('請解釋產品');const running=f.engine.tick();
  f.engine.takeover(r.conversationId);
  assert.equal(f.calls[0].signal.aborted,true);
  f.engine.manualReply(r.conversationId,'由本人核對的合成回覆。');await f.engine.tick();await bounded(running);
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/由本人/);
  pending.resolve(answer);await turn();
  assert.equal(f.store.messages(r.conversationId).filter(m=>m.role==='assistant').length,0);
  f.incoming('本人接手期間補充');await f.engine.tick();assert.equal(f.calls.length,1);
});

test('new incoming text aborts old work, keeps the original deadline and generates only against fresh context',async t=>{
  const old=deferred();let count=0;
  const f=fixture(t,{reply:()=>++count===1?old.promise:Promise.resolve(answer)});
  const r=f.incoming('第一條問題');const running=f.engine.tick();
  const deadline=f.engine.pendingWindow(r.conversationId).deadline_at;
  f.incoming('第二條補充');await bounded(running);
  assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(f.engine.pendingWindow(r.conversationId).deadline_at,deadline);
  await f.engine.tick();assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls[1].input.history.map(m=>m.content),['第一條問題','第二條補充']);
  old.resolve(answer);await turn();
  assert.equal(f.store.messages(r.conversationId).filter(m=>m.role==='assistant').length,1);
});

test('knowledge revisions cancel current generation and reread within the original response window',async t=>{
  const old=deferred();let count=0;
  const f=fixture(t,{reply:()=>++count===1?old.promise:Promise.resolve(answer)});
  const r=f.incoming('請解釋產品');const running=f.engine.tick(),deadline=f.engine.pendingWindow(r.conversationId).deadline_at;
  f.store.revise();await bounded(running);
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.store.get('SELECT state FROM jobs WHERE id=?',r.messageId).state,'pending');
  await f.engine.tick();assert.equal(f.calls.length,2);assert.equal(f.engine.pendingWindow(r.conversationId).deadline_at,deadline);
  old.resolve(answer);await turn();
  assert.equal(f.store.messages(r.conversationId).filter(m=>m.role==='assistant').length,1);
});

test('policy or provider switching cancels work and never reruns an old pending question with new permissions',async t=>{
  for(const change of ['policy','provider']){
    const pending=deferred(),f=fixture(t,{reply:()=>pending.promise});
    const r=f.incoming('改動前的問題'),running=f.engine.tick();
    if(change==='policy')f.engine.configureInbox({...f.engine.inboxPolicy(),automaticAi:true});
    else f.engine.replaceAgent({configured:true,provider:'replacement',reply(){throw Error('Old pending question was replayed');}});
    await bounded(running);await f.engine.tick();
    assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.store.conversation(r.conversationId).state,'waiting');
    assert.equal(f.store.get("SELECT COUNT(*) AS n FROM jobs WHERE state='pending'").n,0);
    pending.resolve(answer);await turn();
    assert.equal(f.store.messages(r.conversationId).filter(m=>m.role==='assistant').length,0);
    assert.equal(f.sent.length,0);
  }
});

test('hard generation timeout and shutdown settle even if a provider ignores AbortSignal forever',async t=>{
  const timed=fixture(t,{reply:()=>new Promise(()=>{}),engineOptions:{responseTimeoutMs:30}});
  const r=timed.incoming('永遠未返回的合成請求');await bounded(timed.engine.tick());
  assert.equal(timed.calls[0].signal.aborted,true);assert.equal(timed.store.conversation(r.conversationId).state,'waiting');
  assert.equal(timed.engine.inboxStatus().pendingCount,1);
  const stopped=fixture(t,{reply:()=>new Promise(()=>{})});const s=stopped.incoming('關機中的合成請求');
  const running=stopped.engine.tick();await bounded(stopped.engine.stop());await bounded(running);
  assert.equal(stopped.calls[0].signal.aborted,true);assert.equal(stopped.engine.running,false);
  assert.equal(stopped.store.get('SELECT state FROM jobs WHERE id=?',s.messageId).state,'pending');
  assert.equal(stopped.sent.length,0);
});

test('source expiry before generation completion and revocation before dispatch block stale automatic answers',async t=>{
  const pending=deferred(),f=fixture(t,{automaticAi:true,reply:()=>pending.promise});
  const r=f.incoming('請解釋產品'),running=f.engine.tick();
  f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?',Date.now()-1,factId);
  pending.resolve(answer);await running;
  assert.equal(f.store.conversation(r.conversationId).state,'waiting');assert.equal(f.sent.length,0);
  const second=fixture(t,{automaticAi:true}),next=second.incoming('另一個產品問題');
  await second.engine.processJob(second.store.get('SELECT * FROM jobs WHERE id=?',next.messageId));
  const queued=second.store.messages(next.conversationId).at(-1);assert.equal(queued.status,'queued');
  second.store.run('UPDATE knowledge SET approved=0 WHERE id=?',factId);await second.engine.dispatch(queued);
  assert.equal(second.store.get('SELECT status FROM messages WHERE id=?',queued.id).status,'cancelled');assert.equal(second.sent.length,0);
});

test('self-to-self input stays read-only with every automatic policy flag enabled',async t=>{
  const f=fixture(t,{automaticAi:true,automaticKnowledge:true});
  const r=f.engine.receiveSelfTest({address:'85255550001@s.whatsapp.net',eventId:'synthetic-self',text:'請解釋產品',timestamp:Date.now()});
  await f.engine.tick();
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal(f.engine.inboxStatus().pendingCount,0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
  assert.throws(()=>f.engine.manualReply(r.conversationId,'不准回覆'),error=>error.status===409);
  assert.throws(()=>f.engine.takeover(r.conversationId,'ai'),error=>error.status===409);
});
