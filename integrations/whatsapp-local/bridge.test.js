import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalBridge, validateDataDirectory, validateNumbers, resolvePhoneAddress, resolveLinkedPhone } from './bridge.js';
import { normalizeEvent } from '../../src/evolution.js';

const key='synthetic-test-service-key-'.repeat(3),secret='synthetic-test-callback-secret-'.repeat(3),instance='test-local';
const number='85255550123',address=number+'@s.whatsapp.net';
const linkedNumber='85255550000',linkedAddress=linkedNumber+':3@s.whatsapp.net';
const webhook={enabled:true,url:'http://127.0.0.1:3199/webhooks/evolution',headers:{Authorization:`Bearer ${secret}`},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']};

async function fixture(t, options={}) {
  const dir=options.dir||mkdtempSync(join(tmpdir(),'bluesai-local-wa-'));
  let stamp=Date.now(),socket=null,calls=[],callbacks=[];
  const mappingRequests=[];
  const loadAuth=async()=>({state:{creds:{registered:false,me:{id:linkedAddress}},keys:{}},saveCreds:async()=>{}});
  const bridge=createLocalBridge({dataDir:dir,instance,apiKey:key,webhookUrl:webhook.url,webhookSecret:secret,allowTestActivation:true,
    makeSocket:config=>{socket={ev:new EventEmitter(),user:config.auth.creds.me,signalRepository:{lidMapping:{getLIDForPN:async pn=>{mappingRequests.push(pn);return '123456789@lid';},getPNForLID:async lid=>lid==='123456789@lid'?number+':0@s.whatsapp.net':null}},sendMessage:async(jid,content,opts)=>{calls.push({jid,content,opts});return {key:{id:opts.messageId}};},end:()=>{}};assert.equal(config.syncFullHistory,false);assert.equal(config.shouldSyncHistoryMessage(),false);assert.equal(config.shouldIgnoreJid(number+':3@s.whatsapp.net'),false);assert.equal(config.shouldIgnoreJid('123456789:3@lid'),false);assert.equal(config.shouldIgnoreJid('123456789@g.us'),true);return socket;},loadAuth,encodeQr:async raw=>'data:image/png;base64,'+Buffer.from(raw).toString('base64'),now:()=>stamp,qrWaitMs:50,
    fetchImpl:async(url,init)=>{callbacks.push({url,init});return new Response('{}');},...options});
  await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+bridge.server.address().port;
  t.after(async()=>{await bridge.close();if(!options.keep)rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const api=async(path,method='GET',input,auth=key)=>{
    const response=await fetch(base+path,{method,headers:{apikey:auth,...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});
    return {status:response.status,data:await response.json()};
  };
  const connect=async()=>{const pending=api(`/instance/connect/${instance}`);while(!socket)await new Promise(resolve=>setTimeout(resolve,1));socket.ev.emit('connection.update',{connection:'open'});return pending;};
  const register=()=>api(`/webhook/set/${instance}`,'POST',{webhook});
  const allow=(numbers=[number],activateSending=true)=>api(`/instance/testRecipients/${instance}`,'PUT',{numbers,activateSending,consent:true});
  const message=(id='in-1',extra={})=>({key:{id,remoteJid:address,fromMe:false},messageTimestamp:stamp/1000,message:{conversation:'［合成測試］你好'},...extra});
  return {bridge,base,api,connect,register,allow,message,dir,calls,callbacks,mappingRequests,get socket(){return socket;},advance:ms=>{stamp+=ms;}};
}

test('local bridge starts idle, authenticates owner API and never invents a QR',async t=>{
  const f=await fixture(t);
  assert.equal(f.socket,null);
  assert.equal((await f.api(`/instance/connect/${instance}`,'GET',undefined,'wrong')).status,401);
  assert.equal(f.socket,null);
  assert.equal((await f.api(`/instance/connect/other`)).status,404);
  const pending=f.api(`/instance/connect/${instance}`);
  while(!f.socket)await new Promise(resolve=>setTimeout(resolve,1));
  const realProviderValue='provider-event-value-used-only-in-unit-test';
  f.socket.ev.emit('connection.update',{qr:realProviderValue});
  const response=await pending;
  assert.equal(response.data.base64,'data:image/png;base64,'+Buffer.from(realProviderValue).toString('base64'));
  assert.equal(response.data.instance.state,'connecting');
  f.advance(21000);
  assert.equal(f.bridge.status().qrAvailable,false);
});

test('empty allowlist and history/placeholder events never forward customer data',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message()]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,0);
  await f.allow([number],false);
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('history')]});
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'placeholder',messages:[f.message('spoof')]});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('undated',{messageTimestamp:undefined}),f.message('old',{messageTimestamp:1})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,0);
  assert.equal(f.bridge.status().webhook.pending,0);
});

test('explicit phone alias is supported without guessing LID/group identities',()=>{
  assert.equal(resolvePhoneAddress({remoteJid:'1234@lid',remoteJidAlt:address}),address);
  assert.equal(resolvePhoneAddress({remoteJid:'1234@lid'}),null);
  assert.equal(resolvePhoneAddress({remoteJid:'1234@g.us',remoteJidAlt:address}),null);
  assert.throws(()=>validateNumbers([number,number]));
  assert.throws(()=>validateNumbers(['+85255550123']));
  assert.throws(()=>validateDataDirectory(resolve('integrations/whatsapp-local/..private')));
});

test('private auth cannot be created inside another Git checkout',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-other-repo-'));
  try{mkdirSync(join(dir,'.git'));assert.throws(()=>validateDataDirectory(join(dir,'not-created-yet','state')),/OUTSIDE_SOURCE/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('manual test activation requires consent, open socket, matching webhook and recipient',async t=>{
  const f=await fixture(t);
  assert.equal((await f.allow()).status,409);
  await f.connect();assert.equal((await f.allow()).status,409);
  assert.equal((await f.api(`/webhook/set/${instance}`,'POST',{webhook:{...webhook,url:'http://127.0.0.1:3199/another'}})).status,409);
  await f.register();
  assert.equal((await f.api(`/instance/testRecipients/${instance}`,'PUT',{numbers:[number],activateSending:true})).status,409);
  const result=await f.allow();assert.equal(result.status,200);assert.equal(result.data.deliveryEnabled,true);
  assert.deepEqual(result.data.maskedNumbers,['••••0123']);assert.doesNotMatch(JSON.stringify(result.data),new RegExp(number));
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:'85255550999',text:'test',linkPreview:false})).status,403);
  assert.equal(f.calls.length,0);
  const sent=await f.api(`/message/sendText/${instance}`,'POST',{number,text:'［合成測試］回覆',linkPreview:false});
  assert.equal(sent.status,201);assert.equal(sent.data.status,'accepted');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].jid,address);
  assert.equal(f.calls[0].content.linkPreview,null);
  // Our own known socket echo does not masquerade as an operator reply.
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message(sent.data.key.id,{key:{id:sent.data.key.id,remoteJid:address,fromMe:true}})]});
  assert.equal(f.bridge.status().webhook.pending,0);
});

test('allowlisted real-shaped inbound and delivery callbacks match the core contract and deduplicate',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow([number],false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message(),f.message()]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  const inbound=JSON.parse(f.callbacks[0].init.body);assert.equal(normalizeEvent(inbound,instance).kind,'incoming');
  assert.equal(f.callbacks[0].init.headers.Authorization,`Bearer ${secret}`);
  assert.equal(f.callbacks[0].init.redirect,'error');assert.doesNotMatch(f.callbacks[0].init.body,/apikey|synthetic-test-service-key/);
  f.socket.ev.emit('messages.update',[{key:{id:'sent-1',remoteJid:address,fromMe:true},update:{status:3}}]);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();const receipt=normalizeEvent(JSON.parse(f.callbacks[1].init.body),instance);
  assert.equal(receipt.receipts[0].status,'delivered');
  f.socket.ev.emit('message-receipt.update',[{key:{id:'sent-1',remoteJid:address,fromMe:true},receipt:{readTimestamp:Date.now()/1000}}]);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(normalizeEvent(JSON.parse(f.callbacks[2].init.body),instance).receipts[0].status,'read');
});

test('callback outbox survives restart while send activation resets closed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-restart-'));
  const first=await fixture(t,{dir,keep:true,fetchImpl:async()=>{throw Error('synthetic failure');}});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await first.connect();await first.register();await first.allow();
  first.socket.ev.emit('messages.upsert',{type:'notify',messages:[first.message('persisted')]});await new Promise(resolve=>setImmediate(resolve));await first.bridge.flush();assert.equal(first.bridge.status().webhook.pending,1);
  await first.bridge.close();
  second=await fixture(t,{dir,keep:true});second.advance(120000);await second.bridge.flush();
  assert.equal(second.callbacks.length,1);assert.equal(JSON.parse(second.callbacks[0].init.body).data.key.id,'persisted');
  assert.equal(second.bridge.status().testMode.count,1);assert.equal(second.bridge.status().testMode.deliveryEnabled,false);
});

test('removing a test recipient stops queued text forwarding and further sends',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow();
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('before-revoke')]});
  await f.allow([],false);await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,0);assert.equal(f.bridge.status().webhook.pending,0);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false})).status,403);
  assert.equal(f.calls.length,0);
});

test('an uncertain send is never automatically resubmitted',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow();let attempts=0;
  f.socket.sendMessage=async()=>{attempts++;throw Error('synthetic timeout');};
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false})).status,502);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();f.advance(120000);await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(attempts,1);
});

test('device-specific LID inbound and known outgoing receipt use explicit provider mapping',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow();
  assert.deepEqual(f.mappingRequests,[address]);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('lid-incoming',{key:{id:'lid-incoming',remoteJid:'123456789:0@lid',fromMe:false}})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(JSON.parse(f.callbacks[0].init.body).data.key.remoteJid,address);
  const sent=await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false});
  f.socket.ev.emit('messages.update',[{key:{id:sent.data.key.id,remoteJid:'999999999@lid',fromMe:true},update:{status:3}}]);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(JSON.parse(f.callbacks[1].init.body).data.remoteJid,address);
  assert.equal(normalizeEvent(JSON.parse(f.callbacks[1].init.body),instance).receipts[0].status,'delivered');
});

test('mapping completing after logout cannot reopen the test send gate',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  let release;f.socket.signalRepository.lidMapping.getLIDForPN=()=>new Promise(resolve=>{release=resolve;});
  const activating=f.allow();while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  f.socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});release('123456789@lid');
  assert.equal((await activating).status,409);assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.bridge.status().testMode.count,0);
});

test('own linked phone is rejected before provider queries and closes an active gate',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const rejected=await f.allow([linkedNumber]);
  assert.equal(rejected.status,409);assert.equal(rejected.data.code,'SELF_TEST_RECIPIENT');
  assert.equal(rejected.data.error.includes(linkedNumber),false);assert.match(rejected.data.error,/另一個/);
  assert.equal(f.mappingRequests.length,0);assert.equal(f.calls.length,0);assert.equal(f.bridge.status().testMode.count,0);assert.equal(f.bridge.status().testMode.deliveryEnabled,false);
  assert.equal((await f.allow()).status,200);assert.equal(f.bridge.status().testMode.deliveryEnabled,true);assert.equal(f.mappingRequests.length,1);
  assert.equal((await f.allow([linkedNumber])).data.code,'SELF_TEST_RECIPIENT');
  assert.equal(f.mappingRequests.length,1);assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.calls.length,0);
});

test('linked account identity uses explicit phone creds and never guesses from an LID',()=>{
  assert.equal(resolveLinkedPhone({user:{id:'123456789:0@lid'}},{creds:{me:{id:linkedAddress}}}),linkedNumber);
  assert.equal(resolveLinkedPhone({user:{id:'123456789:0@lid'}},{creds:{me:{id:'123456789@lid'}}}),null);
  assert.equal(resolveLinkedPhone({user:{id:address}},{creds:{me:{id:linkedAddress}}}),null);
});
