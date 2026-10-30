import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { createLocalWhatsAppPreview } from '../src/local-whatsapp-preview.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';

async function settled(manager){
  const until=Date.now()+2000;
  while(manager.status().status==='preparing'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,1));
  assert.notEqual(manager.status().status,'preparing');return manager.status();
}
function fixture(t,options={}){
  const parent=realpathSync(tmpdir()),dataDir=mkdtempSync(resolve(parent,'bluesai-preview-bridge-'));
  const calls={spawns:[],probes:[],stops:0,kills:0,dependencies:0};
  let callbackIdentity='';
  const spawn=(entry,args,settings)=>{
    const child=new EventEmitter();child.connected=true;child.pid=100+calls.spawns.length;
    child.send=(message,callback)=>{assert.equal(message.type,'bluesai:bridge-stop');calls.stops++;callback?.();if(!options.unresponsive)queueMicrotask(()=>{child.connected=false;child.emit('exit',0);});};
    child.kill=()=>{calls.kills++;if(options.unresponsive)return false;child.connected=false;child.emit('exit',1);return true;};
    calls.spawns.push({entry,args,settings,child});
    const deniedUpgrade=options.requireExplicitUpgrade&&settings.env.WA_LOCAL_WEBHOOK_URL&&callbackIdentity!==settings.env.WA_LOCAL_WEBHOOK_URL&&settings.env.WA_LOCAL_PREVIEW_CALLBACK_UPGRADE!==settings.env.WA_LOCAL_WEBHOOK_URL;
    if(!deniedUpgrade&&settings.env.WA_LOCAL_WEBHOOK_URL)callbackIdentity=settings.env.WA_LOCAL_WEBHOOK_URL;
    if(options.childError||deniedUpgrade)queueMicrotask(()=>child.emit('error',new Error('synthetic-private-startup-error')));
    else if(!options.waitForStop)queueMicrotask(()=>child.emit('message',{type:'bluesai:bridge-ready'}));
    return child;
  };
  const managerOptions={dataDir,spawn,allocatePort:async()=>31997+calls.spawns.length,startupMs:100,shutdownMs:10,exitWaitMs:10,...options.managerOptions,
    dependencyCheck:()=>{calls.dependencies++;if(options.missing||options.failDependencyAt?.includes(calls.dependencies))throw Object.assign(new Error('synthetic-private-dependency-error'),{code:'LOCAL_WHATSAPP_DEPENDENCIES_MISSING'});},
    fetchImpl:async(url,settings)=>{
      calls.probes.push({url,settings});const env=calls.spawns.at(-1).settings.env;
      assert.equal(settings.headers.apikey,env.WA_LOCAL_API_KEY);
      return Response.json({provider:'baileys-local',instance:{instanceName:env.WA_LOCAL_INSTANCE,state:'close'},testMode:{deliveryEnabled:false},webhook:{enabled:false}});
    }};
  const manager=createLocalWhatsAppPreview(managerOptions);
  t.after(async()=>{await manager.close();assert.equal(dirname(realpathSync(dataDir)),parent);assert.ok(basename(dataDir).startsWith('bluesai-preview-bridge-'));rmSync(dataDir,{recursive:true,force:true});});
  return {manager,calls,dataDir,bridgeDir:resolve(dataDir,'whatsapp-link'),recreate:()=>createLocalWhatsAppPreview(managerOptions)};
}

test('preview preparation needs consent, GET stays idle and concurrent requests start only one private idle bridge',async t=>{
  const f=fixture(t);assert.equal(f.manager.status().status,'not_started');
  assert.equal(f.calls.spawns.length,0);assert.equal(existsSync(f.bridgeDir),false);
  assert.throws(()=>f.manager.prepare({consent:false}));assert.throws(()=>f.manager.prepare({consent:true,port:3103}));
  f.manager.prepare({consent:true});f.manager.prepare({consent:true});
  assert.equal((await settled(f.manager)).status,'ready');assert.equal(f.calls.spawns.length,1);
  const {entry,args,settings}=f.calls.spawns[0];
  assert.match(entry,/integrations[\\/]whatsapp-local[\\/]start\.js$/);assert.deepEqual(args,[]);
  assert.equal(settings.windowsHide,true);assert.equal(settings.detached,false);
  assert.deepEqual(settings.execArgv,[],'parent --import/--require flags cannot enter the fixed bridge');
  assert.deepEqual(settings.stdio,['ignore','ignore','ignore','ipc']);
  assert.equal(settings.env.WA_LOCAL_DATA_DIR,f.bridgeDir);
  for(const key of ['WA_LOCAL_DELIVERY_ENABLED','WA_LOCAL_ALLOW_TEST_ACTIVATION'])assert.equal(settings.env[key],'false');
  for(const key of ['WA_LOCAL_TEST_RECIPIENTS','WA_LOCAL_WEBHOOK_URL','WA_LOCAL_WEBHOOK_SECRET'])assert.equal(settings.env[key],'');
  assert.equal(f.calls.probes.length,1);assert.match(f.calls.probes[0].url,/\/instance\/connectionState\//);
  assert.doesNotMatch(JSON.stringify(f.manager.status()),/apikey|bridge-api-key|31997|whatsapp-link|pid/i);
  assert.equal(f.manager.status().canReceive,false);assert.equal(f.manager.status().canSend,false);
});

test('owner inbox preparation upgrades only the same private bridge and keeps callback identity on restart',async t=>{
  const callbackUrl='http://127.0.0.1:3101/webhooks/evolution',webhookSecret='synthetic-preview-webhook-'.repeat(2);
  const f=fixture(t,{managerOptions:{callbackUrl,webhookSecret}});
  assert.equal(f.manager.status().inboxSetupAvailable,true);assert.equal(f.manager.status().callbackReady,false);
  f.manager.prepare({consent:true});await settled(f.manager);
  const first=f.calls.spawns[0].settings.env,connection=f.manager.connection();
  mkdirSync(resolve(f.bridgeDir,'auth'),{recursive:true});writeFileSync(resolve(f.bridgeDir,'auth','synthetic-marker'),'preserved');
  assert.equal(first.WA_LOCAL_WEBHOOK_URL,'');await f.manager.enableInbox();
  const second=f.calls.spawns[1].settings.env;
  assert.equal(second.WA_LOCAL_DATA_DIR,first.WA_LOCAL_DATA_DIR);assert.equal(second.WA_LOCAL_INSTANCE,first.WA_LOCAL_INSTANCE);
  assert.equal(second.WA_LOCAL_API_KEY,connection.apiKey);assert.equal(second.WA_LOCAL_WEBHOOK_URL,callbackUrl);
  assert.equal(second.WA_LOCAL_PREVIEW_CALLBACK_UPGRADE,callbackUrl);assert.equal(second.WA_LOCAL_REQUIRE_INBOX_RECONSENT,'true');
  assert.equal(second.WA_LOCAL_WEBHOOK_SECRET,webhookSecret);assert.equal(second.WA_LOCAL_DELIVERY_ENABLED,'false');
  assert.equal(readFileSync(resolve(f.bridgeDir,'auth','synthetic-marker'),'utf8'),'preserved');
  assert.equal(f.manager.status().callbackReady,true);assert.equal(f.manager.status().canSend,false);
  await f.manager.enableInbox();assert.equal(f.calls.spawns.length,2,'repeated owner registration cannot create another child');
  f.calls.spawns[1].child.emit('exit',1);f.manager.prepare({consent:true});await settled(f.manager);
  assert.equal(f.calls.spawns[2].settings.env.WA_LOCAL_WEBHOOK_URL,callbackUrl);
  assert.equal(f.calls.spawns[2].settings.env.WA_LOCAL_PREVIEW_CALLBACK_UPGRADE,'','ordinary preparation cannot migrate callback identity');
  assert.throws(()=>createLocalWhatsAppPreview({dataDir:f.dataDir,callbackUrl:'http://127.0.0.1:3102/webhooks/evolution',webhookSecret}),/CALLBACK_IDENTITY_CHANGED/);
});

test('failed callback setup survives manager restart but only explicit owner retry can complete the migration',async t=>{
  const f=fixture(t,{failDependencyAt:[2],requireExplicitUpgrade:true,managerOptions:{callbackUrl:'http://127.0.0.1:3101/webhooks/evolution',webhookSecret:'synthetic-retry-secret-'.repeat(2)}});
  f.manager.prepare({consent:true});await settled(f.manager);const original=f.manager.connection();
  mkdirSync(resolve(f.bridgeDir,'auth'),{recursive:true});writeFileSync(resolve(f.bridgeDir,'auth','retry-marker'),'same-auth');
  await assert.rejects(f.manager.enableInbox(),error=>error.status===502);await f.manager.close();
  const restarted=f.recreate();
  try{
    restarted.prepare({consent:true});assert.equal((await settled(restarted)).status,'error');
    assert.equal(f.calls.spawns.at(-1).settings.env.WA_LOCAL_PREVIEW_CALLBACK_UPGRADE,'');
    await restarted.enableInbox();assert.equal(restarted.status().status,'ready');
    assert.equal(f.calls.spawns.at(-1).settings.env.WA_LOCAL_PREVIEW_CALLBACK_UPGRADE,'http://127.0.0.1:3101/webhooks/evolution');
    assert.equal(restarted.connection().apiKey,original.apiKey);assert.equal(restarted.connection().instance,original.instance);
    assert.equal(readFileSync(resolve(f.bridgeDir,'auth','retry-marker'),'utf8'),'same-auth');
  }finally{await restarted.close();}
});

async function inboxFixture(t,options={}){
  const secret='synthetic-local-inbox-secret-'.repeat(2),admin='synthetic-inbox-admin-'.repeat(2);
  const manager=fixture(t,{...options,managerOptions:{callbackUrl:'http://127.0.0.1:3101/webhooks/evolution',webhookSecret:secret,autoReceive:options.autoReceive===true}});
  const store=new Store(':memory:');const rejectPreview=options.rejectPreview===true;let modelCalls=0,sends=0,state='open',webhook=null,phone='85255550000',stateBlock=null;
  let scope={mode:'test',consented:false,replyToReceived:false,includeSelfTests:false};
  const agent={configured:true,provider:'synthetic',reply:async()=>{modelCalls++;return {text:'合成已批准答案',decision:'answer',sourceIds:['synthetic-hours'],engine:'synthetic'};}};
  const engine=new Engine(store,agent,createEvolution(),{localInbox:true});
  store.set('inbox_policy',{enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
  store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','synthetic-hours','合成營業時間','hours','合成已批准答案',1,null,Date.now());
  const savedPolicy=store.value('inbox_policy');
  const connections=createConnections({engine,store,localWhatsAppPreview:manager.manager,allowLocalInboxPreview:true,autoReceivePreview:options.autoReceive===true,publicBaseUrl:'http://127.0.0.1:3101',webhookSecret:secret,fetchImpl:async(url,options={})=>{
    if(url.includes('/connectionState/')){if(stateBlock){const block=stateBlock;stateBlock=null;await block;}return Response.json({provider:'baileys-local',instance:{state,linkedPhone:phone},webhook:{enabled:Boolean(webhook)}});}
    if(url.includes('/connect/'))return Response.json({instance:{state}});
    if(url.includes('/webhook/set/')){webhook=JSON.parse(options.body).webhook;return Response.json({webhook});}
    if(url.includes('/webhook/find/'))return Response.json({webhook});
    if(url.includes('/inboxScope/')){
      if(options.method==='PUT'){const input=JSON.parse(options.body);scope={...input,consented:input.mode==='all_private_text'};}
      return Response.json(scope);
    }
    if(url.includes('/previewInbox/')){if(rejectPreview)return Response.json({}, {status:409});scope={mode:'all_private_text',consented:true,replyToReceived:true,includeSelfTests:false};return Response.json(scope);}
    if(url.includes('/message/sendText/')){sends++;return Response.json({key:{id:'synthetic-sent-'+sends}});}
    throw new Error('Unexpected synthetic endpoint');
  }});
  const server=createApp({store,engine,workbench:connections,adminToken:admin,webhookSecret:secret,activationAt:0});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await engine.stop();store.close();});
  const base='http://127.0.0.1:'+server.address().port,card=base+'/api/agents/bluesai-cs-0001';
  const login=await fetch(card+'/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token:admin})});
  const headers={Origin:base,Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const call=async(path,method='GET',body)=>{const response=await fetch(card+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  const hook=async(id='synthetic-incoming')=>{
    const response=await fetch(base+'/webhooks/evolution',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},body:JSON.stringify({instance:manager.manager.connection()?.instance||'synthetic-stopped',event:'messages.upsert',data:{key:{id,remoteJid:'85255550123@s.whatsapp.net',fromMe:false},message:{conversation:'合成客戶提問'},messageTimestamp:Math.floor(Date.now()/1000)}})});
    return {status:response.status,data:await response.json()};
  };
  if(!options.skipPrepare){await call('/connections/whatsapp-local','POST',{consent:true});await settled(manager.manager);await call('/connections/whatsapp-local');}
  return {...manager,store,engine,connections,call,hook,savedPolicy,counts:()=>({modelCalls,sends}),setState:value=>state=value,setPhone:value=>phone=value,blockNextState:value=>stateBlock=value};
}

test('auto preview starts saved linked device and follows saved automatic reply policies on new arrivals',async t=>{
  const f=await inboxFixture(t,{autoReceive:true,skipPrepare:true});
  mkdirSync(resolve(f.bridgeDir,'auth'),{recursive:true});writeFileSync(resolve(f.bridgeDir,'auth','creds.json'),'synthetic');
  await f.connections.autoReceiveStep();await settled(f.manager);
  await f.connections.autoReceiveStep();await f.connections.autoReceiveStep();
  const status=f.connections.status().whatsapp;
  assert.equal(status.autoReceiveOnConnect,true);assert.equal(status.autoReceiveStatus,'receiving');
  assert.equal(status.receiveEnabled,true);assert.equal(status.webhook.registered,true);assert.equal(status.inboxScope.consented,true);
  assert.equal(status.automaticRepliesAvailable,true);
  assert.equal((await f.hook()).status,200);const c=f.store.conversations()[0];assert.equal(c.state,'ai');
  await f.engine.tick();assert.deepEqual(f.counts(),{modelCalls:1,sends:1});
  assert.equal(f.store.messages(c.id).at(-1).status,'accepted');
  f.engine.takeover(c.id);f.engine.manualReply(c.id,'合成逐筆人工回覆');await f.engine.tick();assert.equal(f.counts().sends,2);
  assert.deepEqual(f.store.value('inbox_policy'),f.savedPolicy);
});

test('auto preview closes old grants on disconnect and refuses a changed or unknown linked account',async t=>{
  const f=await inboxFixture(t,{autoReceive:true});await f.connections.autoReceiveStep();await f.connections.autoReceiveStep();
  assert.equal(f.connections.status().whatsapp.receiveEnabled,true);await f.hook();const c=f.store.conversations()[0];f.engine.takeover(c.id);
  const queued=f.engine.manualReply(c.id,'合成斷線前提交');f.setState('close');await f.connections.autoReceiveStep();await f.engine.tick();assert.equal(f.counts().sends,0);
  f.setState('open');await f.connections.autoReceiveStep();await f.engine.tick();assert.equal(f.counts().sends,0);assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',queued).status,'queued');
  f.setPhone('85255559999');await f.connections.autoReceiveStep();assert.equal(f.connections.status().whatsapp.receiveEnabled,false);assert.equal((await f.hook('synthetic-wrong-account')).status,403);assert.equal(f.counts().sends,0);
});

test('phone status check waits for the in-flight automatic receiver without a false busy failure',async t=>{
  const f=await inboxFixture(t,{autoReceive:true});let release;
  f.blockNextState(new Promise(resolve=>{release=resolve;}));
  const background=f.connections.autoReceiveStep();await new Promise(resolve=>setImmediate(resolve));
  const userCheck=f.call('/connections/whatsapp-check','POST',{});release();await background;
  assert.equal((await userCheck).status,200);
});

test('auto preview never pins an account when the original bridge refuses its account binding',async t=>{
  const f=await inboxFixture(t,{autoReceive:true,rejectPreview:true});f.setPhone('85255559999');
  await f.connections.autoReceiveStep();await f.connections.autoReceiveStep();
  assert.equal(f.connections.status().whatsapp.receiveEnabled,false);
  assert.equal(f.store.get("SELECT value FROM config WHERE key='preview_whatsapp_phone'"),undefined);
});

test('an open connection with unknown phone identity immediately closes the local receive and send grants',async t=>{
  const f=await inboxFixture(t,{autoReceive:true});await f.connections.autoReceiveStep();await f.connections.autoReceiveStep();
  assert.equal(f.connections.status().whatsapp.receiveEnabled,true);
  f.setPhone(null);await f.connections.autoReceiveStep();
  assert.equal(f.connections.status().whatsapp.receiveEnabled,false);assert.equal(f.connections.status().whatsapp.deliveryEnabled,false);
  assert.equal((await f.hook('synthetic-unknown-identity')).status,403);assert.equal(f.counts().sends,0);
});

test('malformed pinned identity closes receive and send while preserving the original private value',async t=>{
  for(const malformed of ['{bad json','null','42','""']){
    const f=await inboxFixture(t,{autoReceive:true});await f.connections.autoReceiveStep();await f.connections.autoReceiveStep();
    assert.equal(f.connections.status().whatsapp.receiveEnabled,true);
    f.store.run("UPDATE config SET value=? WHERE key='preview_whatsapp_phone'",malformed);
    await f.connections.autoReceiveStep();
    assert.equal(f.connections.status().whatsapp.receiveEnabled,false);assert.equal(f.connections.status().whatsapp.deliveryEnabled,false);
    assert.equal(f.store.get("SELECT value FROM config WHERE key='preview_whatsapp_phone'").value,malformed);
    assert.equal((await f.hook('synthetic-invalid-pin')).status,403);assert.equal(f.counts().sends,0);
  }
});

test('same preview keeps receiving scope separate from reply policy and supports explicit draft approval',async t=>{
  const f=await inboxFixture(t);
  const manualPolicy={enabled:true,automaticKnowledge:false,aiFallback:false,automaticAi:false};
  f.engine.configureInbox(manualPolicy);
  assert.equal(f.connections.status().mode,'preview');assert.equal(f.connections.status().whatsapp.receiveSetupAvailable,true);
  assert.equal((await f.hook()).status,401);
  assert.equal((await f.call('/connections/whatsapp-webhook','POST',{})).status,200);
  assert.equal((await f.hook()).status,403);assert.equal(f.store.conversations().length,0);
  assert.equal((await f.call('/connections/whatsapp-inbox','POST',{mode:'all_private_text',consent:true,replyToReceived:false,includeSelfTests:false})).status,200);
  const first=await f.hook();assert.equal(first.status,200);assert.equal((await f.hook()).data.duplicate,true);
  const c=f.store.conversations()[0];assert.equal(c.state,'waiting');assert.ok(f.connections.status().whatsapp.evidence.lastIncomingAt);
  await f.engine.tick();assert.deepEqual(f.counts(),{modelCalls:0,sends:0});assert.deepEqual(f.store.value('inbox_policy'),manualPolicy);
  await f.call('/conversations/'+c.id+'/takeover','POST',{});
  assert.equal((await f.call('/conversations/'+c.id+'/reply','POST',{text:'合成人工回覆'})).status,409);
  assert.equal((await f.call('/connections/whatsapp-inbox','POST',{mode:'all_private_text',consent:true,replyToReceived:true,includeSelfTests:false})).status,200);
  assert.equal((await f.call('/conversations/'+c.id+'/reply','POST',{text:'合成人工回覆'})).status,201);
  await f.engine.tick();assert.equal(f.counts().sends,1);assert.equal(f.store.messages(c.id).at(-1).status,'accepted');
  const draftPolicy={...manualPolicy,aiFallback:true};f.engine.configureInbox(draftPolicy);
  assert.equal((await f.call('/conversations/'+c.id+'/resume','POST',{})).status,200);
  await f.engine.tick();assert.equal(f.counts().modelCalls,0,'resuming never reprocesses the old message');
  assert.equal((await f.hook('synthetic-second')).status,200);await f.engine.tick();
  assert.equal(f.counts().modelCalls,1,'incoming message id is also its scheduled job id');
  const draft=f.store.messages(c.id).at(-1);assert.equal(draft.status,'draft');assert.equal(f.counts().sends,1);
  assert.equal((await f.call('/messages/'+draft.id+'/approve','POST',{text:''})).status,200);await f.engine.tick();
  assert.equal(f.counts().sends,2);assert.deepEqual(f.store.value('inbox_policy'),draftPolicy);
  assert.equal(f.connections.status().whatsapp.automaticRepliesAvailable,true);
});

test('disconnect and child restart revoke grants, keep policy/drafts and never send to a stale owned port',async t=>{
  const f=await inboxFixture(t);await f.call('/connections/whatsapp-webhook','POST',{});
  await f.call('/connections/whatsapp-inbox','POST',{mode:'all_private_text',consent:true,replyToReceived:true});
  await f.hook();const c=f.store.conversations()[0];f.engine.takeover(c.id);
  const pending=f.engine.manualReply(c.id,'合成未送草稿');f.setState('close');
  assert.equal((await f.call('/connections/whatsapp-check','POST',{})).status,200);
  assert.equal(f.connections.status().whatsapp.receiveEnabled,false);await f.engine.tick();assert.equal(f.counts().sends,0);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',pending).status,'queued');
  f.setState('open');await f.call('/connections/whatsapp-check','POST',{});await f.engine.tick();assert.equal(f.counts().sends,0);
  assert.equal((await f.hook('synthetic-reconnect-no-consent')).status,403);
  await f.call('/connections/whatsapp-inbox','POST',{mode:'all_private_text',consent:true,replyToReceived:true});
  await f.engine.tick();assert.equal(f.counts().sends,0,'fresh scope cannot revive an earlier queued send');
  f.calls.spawns.at(-1).child.emit('exit',1);assert.equal(f.connections.status().whatsapp.receiveEnabled,false);
  await f.engine.tick();assert.equal(f.counts().sends,0);
  await f.call('/connections/whatsapp-local','POST',{consent:true});await settled(f.manager);await f.call('/connections/whatsapp-local');
  assert.equal(f.connections.status().whatsapp.receiveEnabled,false);assert.deepEqual(f.store.value('inbox_policy'),f.savedPolicy);
  assert.equal(f.store.get('SELECT content FROM messages WHERE id=?',pending).content,'合成未送草稿');
});

test('owner registerWebhook explicitly recovers a failed upgrade after ordinary phone preparation is refused',async t=>{
  const f=await inboxFixture(t,{failDependencyAt:[2],requireExplicitUpgrade:true});
  assert.equal((await f.call('/connections/whatsapp-webhook','POST',{})).status,502);
  await f.call('/connections/whatsapp-local');
  assert.equal(f.connections.status().whatsapp.receiveSetupAvailable,true);
  await f.call('/connections/whatsapp-local','POST',{consent:true});await settled(f.manager);await f.call('/connections/whatsapp-local');
  assert.equal(f.manager.status().status,'error');assert.equal(f.connections.status().whatsapp.receiveEnabled,false);
  assert.equal((await f.call('/connections/whatsapp-webhook','POST',{})).status,200);
  assert.equal(f.manager.status().status,'ready');assert.equal(f.connections.status().whatsapp.receiveEnabled,false);
  assert.equal(f.connections.status().whatsapp.inboxReplyEnabled,false);
});

test('send rechecks a silently disconnected bridge and cannot inherit the previous manual/model grants',async t=>{
  const f=await inboxFixture(t);await f.call('/connections/whatsapp-webhook','POST',{});
  await f.call('/connections/whatsapp-inbox','POST',{mode:'all_private_text',consent:true,replyToReceived:true});
  await f.hook();const c=f.store.conversations()[0];f.engine.takeover(c.id);
  const id=f.engine.manualReply(c.id,'合成斷線前提交');f.setState('close');
  await f.engine.tick();assert.equal(f.counts().sends,0);assert.equal(f.connections.status().whatsapp.receiveEnabled,false);
  f.setState('open');await f.call('/connections/whatsapp-check','POST',{});await f.engine.tick();assert.equal(f.counts().sends,0);
  assert.throws(()=>f.engine.manualReply(c.id,'合成不可沿用授權'),error=>error.status===409);
  assert.ok(['uncertain','failed','cancelled'].includes(f.store.get('SELECT status FROM messages WHERE id=?',id).status));
});

test('fresh local engine preserves saved policy, jobs and drafts but cannot resume model work or queued sends',async t=>{
  const store=new Store(':memory:');let modelCalls=0,sends=0;
  const policy={enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true};store.set('inbox_policy',policy);
  const old=new Engine(store,{configured:true,provider:'synthetic',reply:async()=>{modelCalls++;}},createEvolution());
  const c=old.receive({channel:'evolution',address:'85255550123@s.whatsapp.net',text:'合成既存來訊',eventId:'synthetic-old'}).conversationId;
  const pending=store.addMessage(c,'staff','合成既存未送文字',{status:'queued'}),draft=store.addMessage(c,'assistant','合成保留草稿',{status:'draft'});
  await old.stop();
  const next=new Engine(store,{configured:true,provider:'synthetic',reply:async()=>{modelCalls++;}}, {configured:true,deliveryEnabled:true,instance:'synthetic-restart',send:async()=>{sends++;}},{localInbox:true});
  t.after(async()=>{await next.stop();store.close();});
  await next.tick();assert.deepEqual({modelCalls,sends},{modelCalls:0,sends:0});
  next.setLocalInboxScope({receive:true,manual:true});await next.tick();
  assert.deepEqual({modelCalls,sends},{modelCalls:0,sends:0});assert.deepEqual(store.value('inbox_policy'),policy);
  assert.equal(store.get('SELECT content FROM messages WHERE id=?',pending).content,'合成既存未送文字');
  assert.equal(store.get('SELECT status FROM messages WHERE id=?',draft).status,'draft');
  assert.equal(store.get('SELECT COUNT(*) n FROM jobs').n,1);
});

test('same-preview reinitialization preserves private login files and reuses the existing secret after its own child exits',async t=>{
  const f=fixture(t);mkdirSync(resolve(f.bridgeDir,'auth'),{recursive:true});
  const token='synthetic-existing-owner-secret-'.repeat(2),marker=resolve(f.bridgeDir,'auth','synthetic-marker');
  writeFileSync(resolve(f.bridgeDir,'bridge-api-key'),token);writeFileSync(marker,'synthetic-login-marker');
  f.manager.prepare({consent:true});await settled(f.manager);
  assert.equal(f.manager.connection().apiKey,token);
  f.calls.spawns[0].child.emit('exit',1);
  assert.equal(f.manager.status().status,'error');assert.equal(f.manager.connection(),null);
  f.manager.prepare({consent:true});await settled(f.manager);
  assert.equal(f.calls.spawns.length,2);assert.equal(f.manager.connection().apiKey,token);
  assert.equal(readFileSync(marker,'utf8'),'synthetic-login-marker');
});

test('existing bridge locks and missing dependencies never launch or overwrite a service',async t=>{
  const locked=fixture(t);mkdirSync(locked.bridgeDir,{recursive:true});
  const lock=resolve(locked.bridgeDir,'bridge.lock');writeFileSync(lock,'synthetic-existing-owner');
  locked.manager.prepare({consent:true});assert.equal((await settled(locked.manager)).code,'LOCAL_WHATSAPP_LOCKED');
  assert.equal(locked.calls.spawns.length,0);assert.equal(readFileSync(lock,'utf8'),'synthetic-existing-owner');
  const missing=fixture(t,{missing:true});missing.manager.prepare({consent:true});
  assert.equal((await settled(missing.manager)).code,'LOCAL_WHATSAPP_DEPENDENCIES_MISSING');
  assert.equal(missing.calls.spawns.length,0);assert.equal(existsSync(missing.bridgeDir),false);
  assert.doesNotMatch(JSON.stringify(missing.manager.status()),/synthetic-private/);
});

test('startup failure stops only its owned child and hides raw errors; closing during preparation cannot publish ready',async t=>{
  const failed=fixture(t,{childError:true});failed.manager.prepare({consent:true});await settled(failed.manager);
  assert.equal(failed.manager.status().status,'error');assert.equal(failed.calls.stops,1);
  assert.doesNotMatch(JSON.stringify(failed.manager.status()),/synthetic-private/);
  const pending=fixture(t,{waitForStop:true});pending.manager.prepare({consent:true});
  while(!pending.calls.spawns.length)await new Promise(resolve=>setImmediate(resolve));
  await pending.manager.close();assert.equal(pending.manager.status().available,false);
  assert.equal(pending.manager.connection(),null);assert.equal(pending.calls.stops,1);
  assert.throws(()=>pending.manager.prepare({consent:true}),error=>error.status===409);
});

test('an unconfirmed child exit keeps ownership and prevents a second process',async t=>{
  const f=fixture(t,{childError:true,unresponsive:true});f.manager.prepare({consent:true});
  assert.equal((await settled(f.manager)).code,'LOCAL_WHATSAPP_STOP_FAILED');
  assert.throws(()=>f.manager.prepare({consent:true}),error=>error.status===409);
  assert.equal(f.calls.spawns.length,1);assert.equal(f.manager.connection(),null);
  f.calls.spawns[0].child.emit('exit',1);
});

test('a ready child error does not claim the process stopped until its exit is confirmed',async t=>{
  const f=fixture(t,{unresponsive:true});f.manager.prepare({consent:true});await settled(f.manager);
  f.calls.spawns[0].child.emit('error',new Error('synthetic-private-late-error'));
  assert.equal(f.manager.status().code,'LOCAL_WHATSAPP_STOP_FAILED');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.manager.status().code,'LOCAL_WHATSAPP_STOP_FAILED');
  assert.throws(()=>f.manager.prepare({consent:true}),error=>error.status===409);
  f.calls.spawns[0].child.emit('exit',1);
});

async function httpFixture(t){
  const f=fixture(t),store=new Store(':memory:'),engine=new Engine(store,createAgent(),createEvolution());
  const requests=[];let connectState='connecting';
  const connections=createConnections({store,engine,localWhatsAppPreview:f.manager,fetchImpl:async(url,settings)=>{
    requests.push({url,settings});
    if(url.includes('/connectionState/'))return Response.json({instance:{state:'open',linkedPhone:'85255550000'}});
    if(url.includes('/qr/'))return Response.json({instance:{state:'close'},base64:'data:image/png;base64,aGVsbG8=',qrAvailable:true});
    return Response.json({instance:{state:connectState},base64:'data:image/png;base64,aGVsbG8=',qrAvailable:true,qrExpiresInMs:20000});
  }});
  const server=createApp({store,engine,workbench:connections,adminToken:'synthetic-local-owner-'.repeat(3)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await engine.stop();store.close();});
  const base='http://127.0.0.1:'+server.address().port,card=base+'/api/agents/bluesai-cs-0001';
  const login=await fetch(card+'/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token:'synthetic-local-owner-'.repeat(3)})});
  const headers={Origin:base,Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};
  const call=async(path,method='GET',body)=>{
    const response=await fetch(card+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  return {...f,store,engine,connections,requests,base,card,headers,call,setConnectState:value=>connectState=value};
}

test('prepare API is owner-only, requires same-origin consent and binds no secret into the client',async t=>{
  const f=await httpFixture(t),path='/connections/whatsapp-local';
  assert.equal((await fetch(f.card+path)).status,401);
  assert.equal((await fetch(f.card+path,{method:'POST',headers:{...f.headers,Origin:'https://unrelated.example.test'},body:'{"consent":true}'})).status,403);
  assert.equal((await f.call(path)).data.status,'not_started');assert.equal(f.calls.spawns.length,0);
  assert.equal((await f.call(path,'POST',{consent:false})).status,400);
  assert.equal((await f.call(path,'POST',{consent:true,url:'http://127.0.0.1:3103'})).status,400);
  assert.equal((await f.call(path,'POST',{consent:true})).status,202);await settled(f.manager);
  assert.equal((await f.call(path)).data.status,'ready');
  const before=(await f.call('/state')).data;
  assert.equal(before.connections.whatsapp.url,f.manager.connection().url);
  assert.equal(before.connections.whatsapp.status,'configured');
  assert.doesNotMatch(JSON.stringify(before),new RegExp(f.manager.connection().apiKey));
  assert.equal((await f.call('/connections/whatsapp','POST',{})).data.status,'connecting');
  assert.equal(f.requests.filter(item=>item.url.includes('/connect/')).length,1);
  for(let count=0;count<3;count++)assert.equal((await f.call('/connections/whatsapp-qr')).data.qr,null);
  assert.equal(f.requests.filter(item=>item.url.includes('/connect/')).length,1,'QR refresh never starts or reconnects a socket');
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal((await f.call('/state')).data.connections.whatsapp.receiveEnabled,false);
});

test('same preview can recover its stopped child while existing external configuration is never replaced',async t=>{
  const f=await httpFixture(t),path='/connections/whatsapp-local';
  await f.call(path,'POST',{consent:true});await settled(f.manager);await f.call(path);
  const originalUrl=f.manager.connection().url;f.calls.spawns[0].child.emit('exit',1);
  const requestsBeforeStoppedCheck=f.requests.length;
  assert.equal((await f.call('/connections/whatsapp-check','POST',{})).status,409);
  assert.equal(f.requests.length,requestsBeforeStoppedCheck,'an expired owned port must never receive a cached API key');
  assert.equal((await f.call(path)).data.status,'error');
  assert.equal((await f.call('/state')).data.connections.whatsapp.status,'unconfigured');
  await f.call(path,'POST',{consent:true});await settled(f.manager);await f.call(path);
  assert.notEqual(f.manager.connection().url,originalUrl);assert.equal(f.calls.spawns.length,2);
  f.setConnectState('open');await f.call('/connections/whatsapp','POST',{});
  let phone=(await f.call('/state')).data.connections.whatsapp;
  assert.equal(phone.checkedAt,undefined);assert.equal(phone.linkedPhone,null,'a connect response cannot certify an owner identity');
  await f.call('/connections/whatsapp-check','POST',{});await f.call(path);
  phone=(await f.call('/state')).data.connections.whatsapp;
  assert.ok(phone.checkedAt>0);assert.equal(phone.linkedPhone,'85255550000');
  const external=await httpFixture(t);
  await external.call('/connections/whatsapp','POST',{url:'https://synthetic-provider.example.test',instance:'synthetic-existing',apiKey:'synthetic-existing-external-key'});
  assert.equal((await external.call(path,'POST',{consent:true})).status,409);
  assert.equal(external.calls.spawns.length,0);
  assert.equal((await external.call('/state')).data.connections.whatsapp.url,'https://synthetic-provider.example.test');
  assert.equal((await external.call('/state')).data.connections.whatsapp.localPreparationAvailable,false);
});
