import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {createAgent} from '../src/agent.js';
import {createEvolution} from '../src/evolution.js';
import {createConnections} from '../src/connections.js';

function setup(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const config={url:'http://127.0.0.1:3105',instance:'test',apiKey:'mock-key-'.repeat(8),deliveryEnabled:true};
  const engine=new Engine(store,createAgent(),createEvolution(config));
  let scope={mode:'test',consented:false,replyToReceived:false},state='open',ignoreWrite=false;
  const secret='mock-hook-'.repeat(8);
  const fetchImpl=async(url,o={})=>{
    if(url.includes('connectionState'))return Response.json({instance:{state}});
    if(url.includes('/webhook/find'))return Response.json({webhook:{enabled:true,url:'http://127.0.0.1:3100/webhooks/evolution',headers:{Authorization:'Bearer '+secret},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']}});
    if(url.includes('/inboxScope/')){if(o.method==='PUT'&&!ignoreWrite){const input=JSON.parse(o.body);scope={mode:input.mode,consented:input.consent,replyToReceived:input.replyToReceived,includeSelfTests:input.includeSelfTests===true};}return Response.json(scope);}
    throw Error('Unexpected request');
  };
  const connections=createConnections({store,engine,providerConfig:config,runtime:true,localWhatsAppTest:true,fetchImpl,publicBaseUrl:'http://127.0.0.1:3100',webhookSecret:secret});
  return {store,engine,connections,setState:s=>state=s,ignoreWrites:()=>ignoreWrite=true,config,fetchImpl};
}
test('all-private receiving and permission to reply are separately consented and checked on readback',async t=>{
  const f=setup(t);assert.equal(f.engine.evolution.deliveryEnabled,false);
  await assert.rejects(f.connections.configureInboxScope({mode:'all_private_text',replyToReceived:true,consent:false}),/確認/);
  await f.connections.configureInboxScope({mode:'all_private_text',replyToReceived:false,consent:true});
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.inboxScope.mode,'all_private_text');
  f.engine.configureInbox({enabled:true,automaticKnowledge:true});
  await f.connections.configureInboxScope({mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal(f.engine.evolution.deliveryEnabled,true);assert.equal(f.connections.status().whatsapp.inboxReplyEnabled,true);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
  await f.connections.configureInboxScope({mode:'test',replyToReceived:false,consent:true});
  assert.equal(f.engine.evolution.deliveryEnabled,false);
});
test('failed connection/readback or a failed durable update closes a formerly enabled inbox sender',async t=>{
  const f=setup(t);
  const input={mode:'all_private_text',replyToReceived:true,consent:true};await f.connections.configureInboxScope(input);
  f.setState('close');await assert.rejects(f.connections.configureInboxScope(input),/連線/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);assert.equal(f.connections.status().whatsapp.inboxReplyEnabled,false);
  f.setState('open');await f.connections.configureInboxScope(input);
  f.ignoreWrites();await assert.rejects(f.connections.configureInboxScope({...input,replyToReceived:false}),/不相符/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  const transaction=f.store.transaction;f.store.transaction=()=>{throw Error('durable-update-failed');};
  await assert.rejects(f.connections.configureInboxScope(input),/durable-update-failed/);f.store.transaction=transaction;
  assert.equal(f.engine.evolution.deliveryEnabled,false);
});
test('a core restart may observe broad receiving but never restores its reply authorization',async t=>{
  const f=setup(t);await f.connections.configureInboxScope({mode:'all_private_text',replyToReceived:true,consent:true});
  const restarted=createConnections({store:f.store,engine:f.engine,providerConfig:f.config,runtime:true,localWhatsAppTest:true,fetchImpl:f.fetchImpl});
  assert.equal((await restarted.getInboxScope()).mode,'all_private_text');assert.equal(restarted.status().whatsapp.inboxReplyEnabled,false);assert.equal(f.engine.evolution.deliveryEnabled,false);
});

test('own-message testing is explicit and read back separately from permission to reply',async t=>{
  const f=setup(t);
  assert.equal(f.connections.status().whatsapp.inboxScope.includeSelfTests,false);
  const input={mode:'all_private_text',replyToReceived:false,consent:true,includeSelfTests:true};
  const result=await f.connections.configureInboxScope(input);
  assert.equal(result.includeSelfTests,true);assert.equal(result.replyToReceived,false);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.ok(result.supported.includes('self_test_text'));assert.ok(!result.excluded.includes('self_messages'));
  await assert.rejects(f.connections.configureInboxScope({...input,includeSelfTests:'yes'}),/自身文字測試/);
  await assert.rejects(f.connections.configureInboxScope({...input,mode:'test'}),/自身文字測試/);
  f.ignoreWrites();
  await assert.rejects(f.connections.configureInboxScope({...input,includeSelfTests:false}),/自身測試範圍讀回不相符/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
});
