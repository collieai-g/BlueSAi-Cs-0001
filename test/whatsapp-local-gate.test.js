import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';

function fixture(t, overrides={}) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const config={url:'http://127.0.0.1:3105',instance:'test-local',apiKey:'mock-bridge-secret-'.repeat(3),deliveryEnabled:false};
  const engine=new Engine(store,createAgent(),createEvolution(config));
  let state='open',registered=true,send=false,ignoreWrite=false,selfRecipient=false;const calls=[];
  const secret='mock-webhook-secret-'.repeat(3);
  const fetchImpl=async(url,options={})=>{
    calls.push({url,method:options.method});
    if(url.includes('/connectionState/'))return Response.json({instance:{state}});
    if(url.includes('/inboxScope/'))return Response.json({mode:'test',consented:false,replyToReceived:false});
    if(url.includes('/webhook/find/'))return Response.json({webhook:{enabled:registered,url:'http://127.0.0.1:3100/webhooks/evolution',headers:{Authorization:'Bearer '+secret},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']}});
    if(url.includes('/testRecipients/')){
      if(options.method==='PUT'&&selfRecipient)return Response.json({code:'SELF_TEST_RECIPIENT'},{status:409});
      if(options.method==='PUT'&&!ignoreWrite){const input=JSON.parse(options.body);assert.equal(input.consent,true);assert.equal(input.activateSending,true);send=true;}
      return Response.json({count:send?1:0,maskedNumbers:send?['••••0001']:[],deliveryEnabled:send,activationAvailable:true});
    }
    throw new Error('Unexpected provider request');
  };
  const connections=createConnections({engine,store,providerConfig:config,runtime:true,localWhatsAppTest:true,publicBaseUrl:'http://127.0.0.1:3100',webhookSecret:secret,fetchImpl,...overrides});
  return {store,engine,connections,calls,setState:value=>state=value,setWebhook:value=>registered=value,ignoreWrites:()=>ignoreWrite=true,rejectSelfRecipient:()=>selfRecipient=true};
}

test('local WhatsApp test sends stay closed until phone, webhook and explicit consent are verified',async t=>{
  const f=fixture(t);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:false}),/同意/);
  assert.equal(f.calls.length,0);
  f.setState('connecting');
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/掃碼/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  f.setState('open');f.setWebhook(false);
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/收件網址/);
  assert.equal(f.calls.some(call=>call.method==='PUT'),false);
  f.setWebhook(true);
  const result=await f.connections.configureTestRecipient({number:'+852 5555 0001',consent:true});
  assert.equal(result.enabled,true);assert.equal(f.engine.evolution.deliveryEnabled,true);
  assert.equal(f.store.value('settings').mode,'review');
  const status=f.connections.status();
  assert.equal(status.whatsapp.readiness.canSend,false);
  assert.deepEqual(status.whatsapp.readiness.missingFields,['商戶名稱','服務說明','人工接手方式']);
  assert.doesNotMatch(JSON.stringify(status),/85255550001|mock-bridge-secret|mock-webhook-secret/);
  assert.equal(f.store.value('profile').name,'');
});

test('an ignored or unknown bridge activation never opens the engine gate',async t=>{
  const f=fixture(t);f.ignoreWrites();
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/讀回核對/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
});

test('test activation is unavailable on ordinary providers and rejects non-loopback configuration',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const engine=new Engine(store,createAgent(),createEvolution());
  await assert.rejects(createConnections({engine,store}).configureTestRecipient({number:'85255550001',consent:true}),/未提供/);
  assert.throws(()=>createConnections({engine,store,runtime:true,localWhatsAppTest:true,providerConfig:{url:'https://provider.example.test',instance:'x',apiKey:'test'}}),/LOOPBACK/);
});

test('a failed phone readiness check closes a previously activated test gate',async t=>{
  const f=fixture(t);
  await f.connections.configureTestRecipient({number:'85255550001',consent:true});
  assert.equal(f.engine.evolution.deliveryEnabled,true);
  f.setState('connecting');
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/掃碼/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
});

test('failed review-mode transaction cannot leave provider sending enabled',async t=>{
  const f=fixture(t);
  f.store.set('settings',{mode:'auto',handoffContact:''});
  const transaction=f.store.transaction;
  f.store.transaction=()=>{throw new Error('simulated durable write failure');};
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/durable write failure/);
  f.store.transaction=transaction;
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
  assert.equal(f.store.value('settings').mode,'auto');
});

test('disconnect closes the core sender before waiting for bridge revocation',async t=>{
  let releaseRevoke, pendingRevoke=false;
  const f=fixture(t,{fetchImpl:async(url,options)=>{
    if(pendingRevoke)throw new Error('simulated unavailable bridge');
    pendingRevoke=true;
    await new Promise(resolve=>{releaseRevoke=resolve;});
    throw new Error('simulated unavailable bridge');
  }});
  // A previously activated provider can be present even when bridge revocation stalls.
  f.engine.evolution=createEvolution({url:'http://127.0.0.1:3105',instance:'test-local',apiKey:'mock-key',deliveryEnabled:true});
  const clearing=f.connections.clearWhatsApp();
  while(!pendingRevoke)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
  releaseRevoke();
  await clearing;
  assert.equal(f.connections.status().whatsapp.status,'unconfigured');
});

test('a new local core process closes a globally enabled provider until fresh test consent',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const config={url:'http://127.0.0.1:3105',instance:'test-local',apiKey:'mock-bridge-secret',deliveryEnabled:true};
  const engine=new Engine(store,createAgent(),createEvolution(config));
  assert.equal(engine.evolution.deliveryEnabled,true);
  const connections=createConnections({engine,store,runtime:true,localWhatsAppTest:true,providerConfig:config});
  assert.equal(engine.evolution.deliveryEnabled,false);
  assert.equal(connections.status().whatsapp.manualTestEnabled,false);
});

test('a linked account cannot masquerade as its own test customer and gets a clear next step',async t=>{
  const f=fixture(t);
  await f.connections.configureTestRecipient({number:'85255550001',consent:true});
  f.rejectSelfRecipient();
  await assert.rejects(f.connections.configureTestRecipient({number:'85255550001',consent:true}),/另一個.*WhatsApp/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.connections.status().whatsapp.manualTestEnabled,false);
  assert.equal(f.connections.status().whatsapp.status,'open');
});
