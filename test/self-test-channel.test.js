import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { normalizeEvent } from '../src/evolution.js';
import { createApp } from '../src/server.js';
import { createInboxContext } from '../src/inbox-context.js';

const instance='self-test-fixture',address='85255550111@s.whatsapp.net';
const text='［合成測試］自己傳給自己的訊息';
const adminToken='synthetic-admin-self-test-'.repeat(3),secret='synthetic-hook-self-test-'.repeat(3);
const basePath='/api/agents/bluesai-cs-0001';
function payload({id='self-1',fromMe=true,marker=true,content=text,timestamp=Math.floor(Date.now()/1000)}={}) {
  return {instance,event:'messages.upsert',data:{key:{id,remoteJid:address,fromMe},localSelfTest:marker,
    messageTimestamp:timestamp,message:{conversation:content},pushName:'不應採用的測試名稱'}};
}
async function fixture(t,{runtimeMode=true,localTest=true,includeSelfTests=true}={}) {
  const store=new Store(':memory:');let modelCalls=0,sends=0;
  const engine=new Engine(store,{configured:true,async reply(){modelCalls++;return{text:'不應產生',decision:'answer',sourceIds:[],engine:'mock'};}},
    {configured:true,deliveryEnabled:true,instance,async send(){sends++;return{providerId:'not-expected'};}});
  engine.configureInbox({enabled:true,automaticKnowledge:true});
  engine.addFaq({question:text,answer:'不應自動回覆自傳測試。',approved:true});
  const workbench={status:()=>({ai:{status:'unconfigured'},whatsapp:{localTest,inboxScope:{includeSelfTests}}})};
  const server=createApp({store,engine,adminToken,webhookSecret:secret,runtimeMode,workbench});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(origin+basePath+'/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:adminToken})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await engine.stop();store.close();});
  async function api(path,method='GET',body){const response=await fetch(origin+basePath+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
  async function hook(value,authorized=true){const response=await fetch(origin+'/webhooks/evolution',{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorized?'Bearer '+secret:'Bearer incorrect'},body:JSON.stringify(value)});return{status:response.status,data:await response.json()};}
  return {store,engine,api,hook,calls:()=>({modelCalls,sends})};
}

test('verified self-test marker is classified before outgoing echoes and rejects old or unsupported content',()=>{
  for(const fromMe of [true,false]){
    const event=normalizeEvent(payload({fromMe}),instance);
    assert.equal(event.kind,'self_test');assert.equal(event.text,text);assert.equal(event.address,address);
    assert.equal(event.name,'WhatsApp 自傳測試（只讀）');
  }
  assert.equal(normalizeEvent(payload({timestamp:1}),instance).kind,'ignore');
  assert.equal(normalizeEvent(payload({content:''}),instance).kind,'ignore');
  const media=payload();media.data.message={imageMessage:{caption:'不應載入'}};
  assert.equal(normalizeEvent(media,instance).kind,'ignore');
  const receipt={instance,event:'messages.update',data:{localSelfTest:true,keyId:'self-1',remoteJid:address,fromMe:true,status:'DELIVERY_ACK'}};
  assert.equal(normalizeEvent(receipt,instance).kind,'ignore');
});

test('self-to-self messages enter a separate real read-only channel without model, FAQ, deadline or customer proof',async t=>{
  const f=await fixture(t);
  f.store.run('INSERT INTO conversations(id,channel,address,name,state,updated_at) VALUES (?,?,?,?,?,?)',
    'old-own-case','evolution',address,'舊有對話','ai',Date.now());
  assert.equal((await f.hook(payload({id:'self-from-me',fromMe:true}))).status,200);
  assert.equal((await f.hook(payload({id:'self-from-other-shape',fromMe:false}))).status,200);
  const duplicate=await f.hook(payload({id:'self-from-me',fromMe:true}));
  assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.customerAcceptance,false);
  const conversations=f.store.conversations().filter(c=>c.channel==='whatsapp_self_test');
  assert.equal(conversations.length,1);const c=conversations[0];
  assert.equal(c.name,'WhatsApp 自傳測試（只讀）');assert.equal(c.state,'self_test');assert.equal(c.last_customer_at,0);
  assert.equal(f.store.conversation('old-own-case').state,'ai');
  assert.deepEqual(f.store.messages(c.id).map(m=>m.content),[text,text]);
  assert.equal(f.store.messages(c.id)[0].provider_id,'self-from-me');
  for(const table of ['jobs','response_windows','handoff_tasks','channel_activity','provider_receipts'])assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n,0);
  await f.engine.tick();assert.deepEqual(f.calls(),{modelCalls:0,sends:0});
  const inbox=await f.api('/inbox');
  assert.equal(inbox.status,200);assert.ok(inbox.data.conversations.some(item=>item.id===c.id));
  assert.equal(inbox.data.pendingCount,0);
});

test('self-test ingress requires signed webhook, actual runtime, local bridge mode and explicit owner scope',async t=>{
  for(const setting of [{runtimeMode:false},{localTest:false},{includeSelfTests:false}]){
    const f=await fixture(t,setting);
    assert.equal((await f.hook(payload())).status,403);
    assert.equal(f.store.conversations().length,0);assert.deepEqual(f.calls(),{modelCalls:0,sends:0});
  }
  const f=await fixture(t);
  assert.equal((await f.hook(payload(),false)).status,401);
  assert.equal(f.store.conversations().length,0);
});

test('self-test control, direct draft saving and forced queued dispatch are blocked server-side',async t=>{
  const f=await fixture(t);await f.hook(payload());
  const c=f.store.conversations()[0];
  for(const action of ['takeover','resume','reply']){
    const response=await f.api(`/conversations/${c.id}/${action}`,'POST',action==='reply'?{text:'不應發送'}:{});
    assert.equal(response.status,409);
  }
  const context=createInboxContext({store:f.store,engine:f.engine});
  const snapshot=context.capture(c.id);
  assert.equal(snapshot.scope,'read-only WhatsApp self test');assert.equal(snapshot.conversation.readOnly,true);assert.deepEqual(snapshot.knowledge,[]);
  assert.throws(()=>context.save({conversationId:c.id,expectedVersion:snapshot.version,expectedRevision:snapshot.revision,
    latestMessageId:snapshot.latestMessageId,verificationCode:snapshot.verificationCode,text:'不應產生 DOT 草稿'}),/自傳測試只供讀取/);
  const apiContext=(await f.api('/inbox/context?conversationId='+c.id)).data;
  assert.equal((await f.api('/inbox/draft','POST',{conversationId:c.id,expectedVersion:apiContext.version,
    expectedRevision:apiContext.revision,latestMessageId:apiContext.latestMessageId,verificationCode:apiContext.verificationCode,text:'不應保存'})).status,409);
  const badDraft=f.store.addMessage(c.id,'assistant','不應批准',{status:'draft',engine:'mock'});
  assert.equal((await f.api(`/messages/${badDraft}/approve`,'POST',{text:'不應批准'})).status,409);
  const forced=f.store.addMessage(c.id,'staff','不應發送',{status:'queued'});
  f.store.run("UPDATE conversations SET state='human' WHERE id=?",c.id);
  await f.engine.dispatch(f.store.get('SELECT * FROM messages WHERE id=?',forced));
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',forced).status,'cancelled');
  assert.deepEqual(f.calls(),{modelCalls:0,sends:0});
  assert.throws(()=>f.engine.receive({channel:'whatsapp_self_test',address,text}),/獨立的只讀/);
});

test('self-test IDs and channel history survive restart without entering customer acceptance',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'bluesai-self-channel-')),path=join(dir,'service.sqlite');
  t.after(()=>{const actual=realpathSync(dir);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('bluesai-self-channel-'));rmSync(actual,{recursive:true});});
  let store=new Store(path),engine=new Engine(store,{configured:false},{instance});
  const event={address,eventId:'persisted-self',text,timestamp:Date.now()};
  engine.configureInbox({enabled:true,automaticKnowledge:true});
  const first=engine.receiveSelfTest(event);await engine.stop();store.close();
  store=new Store(path);engine=new Engine(store,{configured:false,reply(){throw Error('No model for self test');}},{instance});
  try{
    assert.equal(engine.receiveSelfTest(event).duplicate,true);
    const c=store.conversation(first.conversationId);
    assert.equal(c.channel,'whatsapp_self_test');assert.equal(c.last_customer_at,0);
    assert.equal(store.messages(c.id).length,1);assert.equal(store.messages(c.id)[0].content,text);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM channel_activity').n,0);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
    assert.equal(engine.inboxStatus().pendingCount,0);
  }finally{await engine.stop();store.close();}
});
