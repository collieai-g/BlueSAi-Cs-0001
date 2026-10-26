import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createInboxContext } from '../src/inbox-context.js';
import { createApp } from '../src/server.js';

function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());const engine=new Engine(store,createAgent(),createEvolution());engine.configureInbox({enabled:true,automaticKnowledge:false});const live=createInboxContext({store,engine});const input=engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',eventId:'incoming-one',text:'測試問題'});return {store,engine,live,id:input.conversationId};}
const draft=(c,text='待本人確認的草稿')=>({conversationId:c.conversationId,expectedVersion:c.version,expectedRevision:c.revision,latestMessageId:c.latestMessageId,verificationCode:c.verificationCode,text});

test('live inbox context has stable bounded proof, no credentials, and saves an unsent customer-bound draft',t=>{
  const {store,live,id}=fixture(t),a=live.capture(id),b=live.capture(id);
  assert.equal(a.verificationCode,b.verificationCode);assert.equal(a.scope,'draft only');assert.equal(a.conversation.channel,'evolution');
  assert.equal(a.messages.at(-1).content,'測試問題');assert.equal('address' in a.conversation,false);
  assert.doesNotMatch(JSON.stringify(a),/apiKey|webhookSecret|adminToken|provider_id/);
  const result=live.save(draft(a));assert.equal(result.sent,false);assert.equal(result.status,'draft');
  const m=store.get('SELECT * FROM messages WHERE id=?',result.id);assert.equal(m.engine,'codex-dot');assert.equal(m.status,'draft');
  assert.equal(store.get("SELECT count(*) AS n FROM messages WHERE status IN ('sending','queued','accepted','delivered')").n,0);
  assert.throws(()=>live.save(draft(a)),/已更新/);
});
test('new customer input, takeover, source expiry and service restart all invalidate an old draft lease',t=>{
  const f=fixture(t);const first=f.live.capture(f.id);
  f.engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',eventId:'incoming-two',text:'新的問題'});
  assert.throws(()=>f.live.save(draft(first)),/已更新/);
  const second=f.live.capture(f.id);f.engine.takeover(f.id);assert.throws(()=>f.live.save(draft(second)),/已更新/);
  const rule=f.engine.addFaq({question:'營業時間？',answer:'星期一至五。',approved:true});
  const third=f.live.capture(f.id);f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?',Date.now()-1,rule.knowledgeId);
  assert.throws(()=>f.live.save(draft(third)),/已更新/);
  const current=f.live.capture(f.id);const restarted=createInboxContext({store:f.store,engine:f.engine});assert.throws(()=>restarted.save(draft(current)),/已更新/);
});
test('draft proof cannot be reused for another customer or bypass exact input validation',t=>{
  const f=fixture(t),a=f.live.capture(f.id);
  const other=f.engine.receive({channel:'evolution',address:'85255550002@s.whatsapp.net',eventId:'other-incoming',text:'另一位客戶'});
  assert.throws(()=>f.live.save({...draft(a),conversationId:other.conversationId}),/已更新/);
  assert.throws(()=>f.live.save({...draft(a),send:true}),/參數無效/);
  assert.throws(()=>f.live.save(draft(a,' ')),/4000/);
});

test('authenticated inbox routes and SSE share the card session, emit only change hints and never call a model',async t=>{
  const store=new Store(':memory:');let modelCalls=0;
  const engine=new Engine(store,{configured:true,reply:()=>{modelCalls++;throw Error();},learn:()=>{modelCalls++;throw Error();}},createEvolution());
  const workbench=createConnections({store,engine});const token='private-fixture-owner-'.repeat(3);
  const server=createApp({store,engine,workbench,adminToken:token});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const origin='http://127.0.0.1:'+server.address().port,base=origin+'/api/agents/bluesai-cs-0001';
  assert.equal((await fetch(base+'/inbox')).status,401);
  const login=await fetch(base+'/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,method='GET',input,originHeader=origin)=>fetch(base+path,{method,headers:{Cookie:cookie,Origin:originHeader,'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined});
  assert.equal((await call('/inbox/config','PUT',{enabled:true,automaticKnowledge:false},'https://unrelated.test')).status,403);
  assert.equal((await call('/inbox/config','PUT',{enabled:true,automaticKnowledge:false})).status,200);
  assert.equal((await call('/inbox/faq','POST',{question:'合成待確認問題',answer:'這是待確認的商戶資料',approved:false})).status,201);
  assert.equal((await call('/trial','POST',{text:'測試',history:[]})).status,409);assert.equal(modelCalls,0);
  const stream=await call('/inbox/events');assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader=stream.body.getReader();await reader.read();
  const c=engine.receive({channel:'evolution',address:'85255550001@s.whatsapp.net',eventId:'real-shape-fixture',text:'SENSITIVE_CUSTOMER_BODY'});
  const update=new TextDecoder().decode((await reader.read()).value);assert.match(update,/changed/);assert.doesNotMatch(update,/SENSITIVE_CUSTOMER_BODY|8525555|private-fixture/);
  const inbox=await (await call('/inbox')).json();assert.equal(inbox.pendingCount,1);assert.equal(inbox.conversations[0].id,c.conversationId);assert.equal(inbox.notification.externalNotified,false);
  const context=await (await call('/inbox/context?conversationId='+c.conversationId)).json();
  assert.equal((await call('/inbox/draft','POST',draft(context))).status,201);assert.equal(modelCalls,0);
  await reader.cancel();
});
