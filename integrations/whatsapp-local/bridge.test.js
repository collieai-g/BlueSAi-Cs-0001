import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalBridge, validateDataDirectory, validateNumbers, resolvePhoneAddress, resolveLinkedPhone } from './bridge.js';
import { normalizeEvent, createEvolution } from '../../src/evolution.js';

const key='synthetic-test-service-key-'.repeat(3),secret='synthetic-test-callback-secret-'.repeat(3),instance='test-local';
const number='85255550123',address=number+'@s.whatsapp.net';
const linkedNumber='85255550000',linkedAddress=linkedNumber+':3@s.whatsapp.net';
const webhook={enabled:true,url:'http://127.0.0.1:3199/webhooks/evolution',headers:{Authorization:`Bearer ${secret}`},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']};

async function fixture(t, options={}) {
  const dir=options.dir||mkdtempSync(join(tmpdir(),'bluesai-local-wa-'));
  let stamp=Date.now(),socket=null,calls=[],callbacks=[];
  const mappingRequests=[];
  const loadAuth=async()=>({state:{creds:{registered:false,me:{id:linkedAddress}},keys:{}},saveCreds:async()=>{}});
  const bridge=createLocalBridge({dataDir:dir,instance,apiKey:key,webhookUrl:webhook.url,webhookSecret:secret,allowTestActivation:true,flushIntervalMs:60000,
    makeSocket:config=>{socket={ev:new EventEmitter(),user:config.auth.creds.me,signalRepository:{lidMapping:{getLIDForPN:async pn=>{mappingRequests.push(pn);return '123456789@lid';},getPNForLID:async lid=>lid==='123456789@lid'?number+':0@s.whatsapp.net':null}},sendMessage:async(jid,content,opts)=>{calls.push({jid,content,opts});return {key:{id:opts.messageId}};},end:()=>{}};assert.equal(config.syncFullHistory,false);assert.equal(config.shouldSyncHistoryMessage(),false);assert.equal(config.shouldIgnoreJid(number+':3@s.whatsapp.net'),false);assert.equal(config.shouldIgnoreJid('123456789:3@lid'),false);assert.equal(config.shouldIgnoreJid('123456789@g.us'),true);socket.providerConfig=config;return socket;},loadAuth,encodeQr:async raw=>'data:image/png;base64,'+Buffer.from(raw).toString('base64'),now:()=>stamp,qrWaitMs:50,
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

test('empty allowlist and old or undated recovered events never forward customer data',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message()]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,0);
  await f.allow([number],false);
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('history',{messageTimestamp:1})]});
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'placeholder',messages:[f.message('spoof',{messageTimestamp:1})]});
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

test('all-private inbox requires owner authentication, explicit consent, open phone and verified webhook',async t=>{
  const f=await fixture(t),path=`/instance/inboxScope/${instance}`;
  assert.equal((await f.api(path)).data.mode,'test');
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text',consent:true},'wrong')).status,401);
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text',consent:true})).status,409);
  await f.connect();
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text',consent:true})).status,409);
  await f.register();
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text'})).status,409);
  assert.equal(f.bridge.status().inboxScope.mode,'test');
  const granted=await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  assert.equal(granted.status,200);assert.equal(granted.data.consented,true);
  assert.equal(granted.data.sendingScope,'test_allowlist');assert.equal(granted.data.deliveryEnabled,false);
  assert.deepEqual(granted.data.excluded,['history','groups','broadcasts','self_messages','media']);
  assert.doesNotMatch(JSON.stringify(granted.data),/synthetic-test|8525555/);
});

test('all-private inbox receives unlisted fresh direct texts and verified LIDs without widening sending',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[
    f.message('all-direct'),
    f.message('all-lid',{key:{id:'all-lid',remoteJid:'123456789:3@lid',fromMe:false}}),
    f.message('bad-lid',{key:{id:'bad-lid',remoteJid:'999999999@lid',fromMe:false}}),
    f.message('group',{key:{id:'group',remoteJid:'123456789@g.us',remoteJidAlt:address,fromMe:false}}),
    f.message('self',{key:{id:'self',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true}}),
    f.message('own-pn',{key:{id:'own-pn',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:false}}),
    f.message('media',{message:{imageMessage:{caption:'［合成測試］不轉送媒體'}}}),
    f.message('old',{messageTimestamp:1}),
  ]});
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('history',{messageTimestamp:1})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();await f.bridge.flush();
  assert.equal(f.callbacks.length,2);
  assert.deepEqual(f.callbacks.map(c=>JSON.parse(c.init.body).data.key.id),['all-direct','all-lid']);
  assert.equal(f.bridge.status().testMode.count,0);assert.equal(f.bridge.status().testMode.deliveryEnabled,false);
  assert.equal(f.mappingRequests.length,0);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false})).status,403);
  assert.equal(f.calls.length,0);
});

test('broad receiving closes prior sender and later explicit sending remains limited to test recipients',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow();
  assert.equal(f.bridge.status().testMode.deliveryEnabled,true);
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false})).status,409);
  await f.allow();
  assert.equal(f.bridge.status().inboxScope.mode,'test');
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:'85255550999',text:'test',linkPreview:false})).status,403);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'［合成測試］明確範圍',linkPreview:false})).status,201);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].jid,address);
});

test('owner-consented receiving and queued inbound survive restart without activating any sender',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-inbox-restart-'));
  const first=await fixture(t,{dir,keep:true,fetchImpl:async()=>{throw Error('synthetic failure');}});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await first.connect();await first.register();
  await first.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  first.socket.ev.emit('messages.upsert',{type:'notify',messages:[first.message('persisted-broad-inbound')]});
  await new Promise(resolve=>setImmediate(resolve));await first.bridge.flush();
  assert.equal(first.bridge.status().webhook.pending,1);await first.bridge.close();
  second=await fixture(t,{dir,keep:true});second.advance(120000);await second.connect();await second.bridge.flush();
  assert.equal(second.bridge.status().inboxScope.mode,'all_private_text');
  assert.equal(second.bridge.status().inboxScope.consented,true);
  assert.equal(second.bridge.status().testMode.deliveryEnabled,false);assert.equal(second.bridge.status().testMode.count,0);
  assert.equal(second.callbacks.length,1);assert.equal(JSON.parse(second.callbacks[0].init.body).data.key.id,'persisted-broad-inbound');
});

test('revoked or malformed broad scope purges out-of-scope pending bodies and stays fail-closed',async t=>{
  const f=await fixture(t,{fetchImpl:async()=>{throw Error('synthetic unavailable callback');}});await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('to-revoke')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bridge.status().webhook.pending,1);
  assert.equal((await f.api(path,'PUT',{mode:'test',consent:true})).status,200);
  assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.bridge.status().inboxScope.mode,'test');
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('before-malformed')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bridge.status().webhook.pending,1);
  assert.equal((await f.api(path,'PUT',{mode:'everything',consent:true})).status,409);
  assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.bridge.status().inboxScope.mode,'test');
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.calls.length,0);
});

test('a delayed incoming LID resolution cannot cross an owner receive-scope change',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  let release;f.socket.signalRepository.lidMapping.getPNForLID=()=>new Promise(resolve=>{release=resolve;});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('stale-mapping',{key:{id:'stale-mapping',remoteJid:'123456789@lid',fromMe:false}})]});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.api(path,'PUT',{mode:'test',consent:true});
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  release(address);await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,0);assert.equal(f.bridge.status().webhook.pending,0);
});

test('explicit broad reply gate only answers verified recent incoming and retains correlated receipts',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`,send=()=>f.api(`/message/sendText/${instance}`,'POST',{number,text:'［合成測試］回覆來訊',linkPreview:false});
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('eligible-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal((await send()).status,403);
  const enabled=await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal(enabled.status,200);assert.equal(enabled.data.replyToReceived,true);assert.equal(enabled.data.replyScope,'recent_incoming_only');
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.bridge.status().testMode.count,0);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:'85255550999',text:'test',linkPreview:false})).status,403);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:linkedNumber,text:'test',linkPreview:false})).status,403);
  const sent=await send();assert.equal(sent.status,201);assert.equal(f.calls.length,1);
  f.socket.ev.emit('messages.update',[{key:{id:sent.data.key.id,remoteJid:address,fromMe:true},update:{status:3}}]);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  const receipt=normalizeEvent(JSON.parse(f.callbacks.at(-1).init.body),instance);
  assert.equal(receipt.kind,'receipt');assert.equal(receipt.receipts[0].status,'delivered');
  f.advance(86400000);assert.equal((await send()).status,403);assert.equal(f.calls.length,1);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('renewed-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal((await send()).status,201);
  f.socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});
  assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
});

test('broad reply authorization resets on restart and old-account arrivals never authorize another account',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-reply-restart-'));
  const first=await fixture(t,{dir,keep:true});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await first.connect();await first.register();
  await first.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  first.socket.ev.emit('messages.upsert',{type:'notify',messages:[first.message('other-account-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));await first.bridge.close();
  second=await fixture(t,{dir,keep:true,loadAuth:async()=>({state:{creds:{registered:true,me:{id:'85255550888:1@s.whatsapp.net'}},keys:{}},saveCreds:async()=>{}})});
  assert.equal(second.bridge.status().inboxScope.mode,'all_private_text');assert.equal(second.bridge.status().inboxScope.replyToReceived,false);
  await second.connect();
  const send=()=>second.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false});
  assert.equal((await send()).status,403);
  assert.equal((await second.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true})).status,200);
  assert.equal((await send()).status,403);assert.equal(second.calls.length,0);
  second.socket.ev.emit('messages.upsert',{type:'notify',messages:[second.message('new-account-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal((await send()).status,201);
});

test('changing test-recipient or inbox scope closes broad replies and cannot re-open an older activation',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal(f.bridge.status().inboxScope.replyToReceived,true);
  await f.allow([],false);assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
  let release;f.socket.signalRepository.lidMapping.getLIDForPN=()=>new Promise(resolve=>{release=resolve;});
  const oldActivation=f.allow();while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  release('123456789@lid');assert.equal((await oldActivation).status,409);
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.bridge.status().inboxScope.replyToReceived,true);
  assert.equal((await f.api(path,'PUT',{mode:'test',replyToReceived:true,consent:true})).status,409);
  assert.equal(f.bridge.status().inboxScope.mode,'test');assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
});

test('a bounded callback batch drains a burst without adding one second per customer text',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:Array.from({length:30},(_,i)=>f.message('burst-'+i))});
  await new Promise(resolve=>setImmediate(resolve));
  await f.bridge.flush();assert.equal(f.callbacks.length,25);assert.equal(f.bridge.status().webhook.pending,5);
  await f.bridge.flush();assert.equal(f.callbacks.length,30);assert.equal(f.bridge.status().webhook.pending,0);
});

test('phone-side human replies for recent customers become outgoing takeovers while self and unseen echoes stay private',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('known-customer')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  const bot=await f.api(`/message/sendText/${instance}`,'POST',{number,text:'［合成測試］機器回覆',linkPreview:false});
  assert.equal(bot.status,201);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[
    f.message('phone-staff',{key:{id:'phone-staff',remoteJid:address,fromMe:true},message:{conversation:'［合成測試］手機人工接手'}}),
    f.message(bot.data.key.id,{key:{id:bot.data.key.id,remoteJid:address,fromMe:true}}),
    f.message('self',{key:{id:'self',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true}}),
    f.message('unseen',{key:{id:'unseen',remoteJid:'85255550999@s.whatsapp.net',fromMe:true}}),
  ]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,2);
  const outgoing=JSON.parse(f.callbacks[1].init.body);assert.equal(outgoing.data.key.fromMe,true);assert.equal(normalizeEvent(outgoing,instance).kind,'outgoing');
  assert.equal(outgoing.data.key.id,'phone-staff');assert.match(outgoing.data.message.conversation,/手機人工接手/);
});

test('revoking all-private scope purges queued phone-side reply bodies even for a remaining test recipient',async t=>{
  const f=await fixture(t,{fetchImpl:async()=>{throw Error('synthetic unavailable callback');}});await f.connect();await f.register();await f.allow([number],false);
  const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('known-customer-for-revoke')]});
  await new Promise(resolve=>setImmediate(resolve));
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('queued-phone-reply',{key:{id:'queued-phone-reply',remoteJid:address,fromMe:true}})]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bridge.status().webhook.pending,2);
  await f.api(path,'PUT',{mode:'test',consent:true});
  assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.bridge.status().testMode.count,1);
});

test('test-only reconfiguration revokes broad reception and purges its bodies even if the phone write fails',async t=>{
  const f=await fixture(t,{fetchImpl:async()=>{throw Error('synthetic unavailable callback');}});await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('before-test-only')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bridge.status().webhook.pending,1);
  const invalid=await f.api(`/instance/testRecipients/${instance}`,'PUT',{numbers:['invalid'],activateSending:true,consent:true});
  assert.equal(invalid.status,400);
  assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.bridge.status().inboxScope.mode,'test');
  assert.equal(f.bridge.status().inboxScope.consented,false);assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('after-test-only')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.bridge.status().webhook.pending,0);
});

test('a persisted broad receive grant cannot transfer to another or unresolved linked account',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-account-scope-'));
  const first=await fixture(t,{dir,keep:true,fetchImpl:async()=>{throw Error('synthetic unavailable callback');}});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await first.connect();await first.register();
  await first.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  first.socket.ev.emit('messages.upsert',{type:'notify',messages:[first.message('old-account-body')]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(first.bridge.status().webhook.pending,1);await first.bridge.close();
  second=await fixture(t,{dir,keep:true,loadAuth:async()=>({state:{creds:{registered:true,me:{id:'85255550888:1@s.whatsapp.net'}},keys:{}},saveCreds:async()=>{}})});
  await second.bridge.flush();assert.equal(second.callbacks.length,0);assert.equal(second.bridge.status().webhook.pending,1);
  await second.connect();assert.equal(second.bridge.status().inboxScope.mode,'test');assert.equal(second.bridge.status().inboxScope.consented,false);
  assert.equal(second.bridge.status().webhook.pending,0);assert.equal(second.bridge.status().inboxScope.replyToReceived,false);
  second.socket.ev.emit('messages.upsert',{type:'notify',messages:[second.message('new-unconsented-account')]});
  await new Promise(resolve=>setImmediate(resolve));await second.bridge.flush();assert.equal(second.callbacks.length,0);
  const scope=await second.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  assert.equal(scope.status,200);assert.doesNotMatch(JSON.stringify(scope.data),/8525555/);
  second.socket.user.id='123456789@lid';
  second.socket.ev.emit('messages.upsert',{type:'notify',messages:[second.message('unresolved-owner')]});
  await new Promise(resolve=>setImmediate(resolve));await second.bridge.flush();
  assert.equal(second.callbacks.length,0);assert.equal(second.bridge.status().inboxScope.mode,'test');
});

test('fresh offline append and recovered real text are accepted once within account consent, including the consent second',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  const path=`/instance/inboxScope/${instance}`;
  const consentSecond=Math.floor(f.message().messageTimestamp);
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number,text:'test',linkPreview:false})).status,403);
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('offline-new',{messageTimestamp:consentSecond})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'synthetic-pdo-request-sensitive',messages:[f.message('offline-new',{messageTimestamp:consentSecond})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  f.advance(2000);
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'synthetic-pdo-other',messages:[f.message('recovered-new',{messageTimestamp:consentSecond+1})]});
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[
    f.message('before-consent',{messageTimestamp:consentSecond-1}),f.message('old-history',{messageTimestamp:1}),
    f.message('future',{messageTimestamp:consentSecond+100}),f.message('missing-date',{messageTimestamp:undefined}),
  ]});
  f.socket.ev.emit('messages.upsert',{type:'history',messages:[f.message('history-event')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,2);assert.equal(JSON.parse(f.callbacks[1].init.body).data.key.id,'recovered-new');
  const d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.queued.incoming,2);assert.equal(d.queued.duplicate,1);assert.equal(d.upserts.requestId,2);
  assert.equal(d.rejected.stale,4);assert.equal(d.rejected.eventType,1);assert.equal(f.calls.length,0);
});

test('ephemeral plain and extended text are received while view-once and media wrappers stay unsupported',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[
    f.message('ephemeral-plain',{message:{ephemeralMessage:{message:{conversation:'［合成測試］限時文字'}}}}),
    f.message('ephemeral-extended',{message:{ephemeralMessage:{message:{ephemeralMessage:{message:{extendedTextMessage:{text:'［合成測試］限時長文字'}}}}}}}),
    f.message('view-once',{message:{viewOnceMessage:{message:{conversation:'［合成測試］不轉送單次內容'}}}}),
    f.message('ephemeral-media',{message:{ephemeralMessage:{message:{imageMessage:{caption:'［合成測試］不轉送圖片'}}}}}),
  ]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,2);assert.deepEqual(f.callbacks.map(c=>JSON.parse(c.init.body).data.key.id),['ephemeral-plain','ephemeral-extended']);
  assert.equal(f.bridge.status().receiveDiagnostics.rejected.nonText,2);assert.equal(f.calls.length,0);
});

test('receive diagnostics identify rejected shapes without recording content or identity',async t=>{
  const f=await fixture(t);await f.connect();await f.register();await f.allow([number],false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[
    f.message('invalid-key',{key:{id:'invalid-key',remoteJid:address}}),
    f.message('stale-key',{messageTimestamp:1}),
    f.message('not-text',{message:{audioMessage:{url:'synthetic-private-media-url'}}}),
    f.message('oversize',{message:{conversation:'x'.repeat(4001)}}),
    f.message('unmapped-key',{key:{id:'unmapped-key',remoteJid:'999999999@lid',fromMe:false}}),
    f.message('other-person',{key:{id:'other-person',remoteJid:'85255550999@s.whatsapp.net',fromMe:false}}),
  ]});
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('old-append',{messageTimestamp:1})]});
  f.socket.ev.emit('messages.upsert',{type:'other',messages:[f.message('unknown-event')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  const d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.scope,'process');assert.equal(d.upserts.events,3);assert.equal(d.upserts.notify,1);assert.equal(d.upserts.append,1);assert.equal(d.upserts.other,1);
  assert.equal(d.rejected.invalidKey,1);assert.equal(d.rejected.stale,2);assert.equal(d.rejected.nonText,1);assert.equal(d.rejected.oversize,1);assert.equal(d.rejected.unmapped,1);assert.equal(d.rejected.outOfScope,1);assert.equal(d.rejected.eventType,1);
  assert.doesNotMatch(JSON.stringify(d),/8525555|synthetic-private|invalid-key|unknown-event|@|apikey|conversation|audioMessage/);
  d.rejected.stale=999;assert.equal(f.bridge.status().receiveDiagnostics.rejected.stale,2);
  assert.equal(f.callbacks.length,0);
});

test('receive diagnostics distinguish queued deduplication and callback failure from eventual success',async t=>{
  let failing=true;
  const f=await fixture(t,{fetchImpl:async()=>{if(failing)throw Error('synthetic-private-error-must-not-be-returned');return new Response('{}');}});
  await f.connect();await f.register();await f.allow([number],false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('diagnostic-incoming'),f.message('diagnostic-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  let d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.queued.incoming,1);assert.equal(d.queued.duplicate,1);assert.equal(d.callbacks.failure,1);assert.equal(d.callbacks.success,0);assert.equal(typeof d.callbacks.lastFailureAt,'number');
  failing=false;f.advance(2000);await f.bridge.flush();d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.callbacks.success,1);assert.equal(typeof d.callbacks.lastSuccessAt,'number');
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'synthetic-private-request',messages:[f.message('diagnostic-incoming')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.queued.duplicate,2);assert.equal(d.callbacks.success,1);assert.equal(d.upserts.requestId,1);
  assert.doesNotMatch(JSON.stringify(d),/synthetic-private|diagnostic-incoming|8525555|@|error-must/);
});

test('raw hosted private JIDs reach SDK canonicalization but never bypass final private-phone validation',async t=>{
  const f=await fixture(t);
  await f.connect();await f.register();
  const providerConfig=f.socket.providerConfig;
  for(const jid of [number+'@hosted',number+':3@hosted',number+'_128:3@hosted','123456789@hosted.lid','123456789:3@hosted.lid'])assert.equal(providerConfig.shouldIgnoreJid(jid),false);
  for(const jid of ['123456789@g.us','status@broadcast','1234@newsletter','13135550000@bot','server@hosted','1234@hosted.lid.evil'])assert.equal(providerConfig.shouldIgnoreJid(jid),true);
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('raw-not-canonical',{key:{id:'raw-not-canonical',remoteJid:number+'@hosted',fromMe:false}}),f.message('sdk-canonical-private')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,1);assert.equal(JSON.parse(f.callbacks[0].init.body).data.key.id,'sdk-canonical-private');
  assert.equal(f.bridge.status().receiveDiagnostics.rejected.unmapped,1);
});

test('one malformed upsert item never aborts valid messages later in the same batch',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[null,undefined,42,[],f.message('valid-after-malformed')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(f.callbacks.length,1);assert.equal(JSON.parse(f.callbacks[0].init.body).data.key.id,'valid-after-malformed');
  assert.equal(f.bridge.status().receiveDiagnostics.rejected.invalidKey,4);assert.equal(f.bridge.status().receiveDiagnostics.queued.incoming,1);
});

test('same-account grant refresh preserves unsent deduplicated bodies, while a concurrent revoke cannot resurrect them',async t=>{
  let failing=true,forwarded=0;
  const f=await fixture(t,{fetchImpl:async()=>{if(failing)throw Error('synthetic callback unavailable');forwarded++;return new Response('{}');}});
  await f.connect();await f.register();const path=`/instance/inboxScope/${instance}`;
  const originalSecond=Math.floor(f.message().messageTimestamp);
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('unsent-refresh-body',{messageTimestamp:originalSecond})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.bridge.status().webhook.pending,1);
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal(f.bridge.status().webhook.pending,1);
  failing=false;f.advance(2000);await f.bridge.flush();assert.equal(forwarded,1);
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'synthetic-recovery',messages:[f.message('unsent-refresh-body',{messageTimestamp:originalSecond})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(forwarded,1);
  failing=true;
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('pending-before-revoke')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.bridge.status().webhook.pending,1);
  let heldRequest;
  const heldResponse=new Promise((resolve,reject)=>{
    heldRequest=httpRequest(f.base+path,{method:'PUT',headers:{apikey:key,'Content-Type':'application/json'}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));
    });heldRequest.on('error',reject);heldRequest.write('{"mode":');
  });
  t.after(()=>heldRequest.destroy());
  while(f.bridge.status().inboxScope.mode!=='test')await new Promise(resolve=>setImmediate(resolve));
  failing=false;await f.bridge.flush();assert.equal(forwarded,1);assert.equal(f.bridge.status().webhook.pending,1);
  assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
  assert.equal((await f.api(path,'PUT',{mode:'test',consent:true})).status,200);
  assert.equal(f.bridge.status().webhook.pending,0);f.advance(2000);
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text',consent:true})).status,200);
  heldRequest.end('"all_private_text","consent":true}');assert.equal((await heldResponse).status,409);
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('old-after-revoke',{messageTimestamp:originalSecond})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  assert.equal(forwarded,1);assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.bridge.status().inboxScope.mode,'all_private_text');
});

test('self-to-self text is an explicit read-only local test for either provider fromMe value, never a customer or send target',async t=>{
  const f=await fixture(t);await f.connect();await f.register();const path=`/instance/inboxScope/${instance}`;
  const self=(id,fromMe)=>f.message(id,{key:{id,remoteJid:linkedNumber+'@s.whatsapp.net',fromMe}});
  await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,consent:true});
  assert.equal(f.bridge.status().inboxScope.includeSelfTests,false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[self('disabled-true',true),self('disabled-false',false)]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,0);
  const enabled=await f.api(path,'PUT',{mode:'all_private_text',replyToReceived:true,includeSelfTests:true,consent:true});
  assert.equal(enabled.data.includeSelfTests,true);assert.equal(enabled.data.supported.includes('self_test_text'),true);assert.equal(enabled.data.excluded.includes('self_messages'),false);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[self('self-true',true),self('self-false',false),f.message('normal-customer-unchanged')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,3);
  assert.equal(JSON.parse(f.callbacks[0].init.body).data.localSelfTest,true);assert.equal(JSON.parse(f.callbacks[1].init.body).data.localSelfTest,true);
  assert.equal(JSON.parse(f.callbacks[2].init.body).data.localSelfTest,undefined);
  const db=new DatabaseSync(join(f.dir,'bridge.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) AS n FROM observed_inbox_contacts WHERE address=?').get(linkedNumber+'@s.whatsapp.net').n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM observed_inbox_contacts WHERE address=?').get(address).n,1);db.close();
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:linkedNumber,text:'不可自動回覆自己',linkPreview:false})).status,403);
  assert.equal(f.calls.length,0);const d=f.bridge.status().receiveDiagnostics;
  assert.equal(d.queued.selfTest,2);assert.equal(d.queued.incoming,1);assert.equal(d.queued.outgoing,0);
});

test('self-test consent has its own seconds boundary and refresh preserves it without replaying a recovered duplicate',async t=>{
  const f=await fixture(t);await f.connect();await f.register();const path=`/instance/inboxScope/${instance}`;
  const firstSecond=Math.floor(f.message().messageTimestamp);
  const self=(id,second)=>f.message(id,{key:{id,remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true},messageTimestamp:second});
  await f.api(path,'PUT',{mode:'all_private_text',consent:true});f.advance(3000);
  await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[self('before-self-consent',firstSecond+1),self('same-self-second',firstSecond+3)]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  f.advance(3000);await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',requestId:'synthetic-self-recovery',messages:[self('same-self-second',firstSecond+3),self('after-original-self-grant',firstSecond+4)]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,2);
  assert.equal(f.bridge.status().receiveDiagnostics.queued.selfTest,2);assert.equal(f.bridge.status().receiveDiagnostics.queued.incoming,0);
  assert.equal(f.bridge.status().receiveDiagnostics.queued.duplicate,1);assert.equal(f.calls.length,0);
});

test('self-test callbacks survive same-grant validation but are purged on revoke or failed grant while ordinary pending text remains scoped',async t=>{
  let failing=true,forwarded=[];
  const f=await fixture(t,{fetchImpl:async(url,init)=>{if(failing)throw Error('synthetic callback unavailable');forwarded.push(JSON.parse(init.body));return new Response('{}');}});
  await f.connect();await f.register();const path=`/instance/inboxScope/${instance}`;
  await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('pending-self',{key:{id:'pending-self',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true}}),f.message('pending-real-customer')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.bridge.status().webhook.pending,2);
  await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});assert.equal(f.bridge.status().webhook.pending,2);
  await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:false,consent:true});assert.equal(f.bridge.status().webhook.pending,1);
  failing=false;f.advance(2000);await f.bridge.flush();assert.equal(forwarded.length,1);assert.equal(forwarded[0].data.localSelfTest,undefined);
  await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('failed-grant-self',{key:{id:'failed-grant-self',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:false}})]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bridge.status().webhook.pending,1);
  assert.equal((await f.api(path,'PUT',{mode:'all_private_text',includeSelfTests:'yes',consent:true})).status,409);
  assert.equal(f.bridge.status().inboxScope.includeSelfTests,false);assert.equal(f.bridge.status().webhook.pending,0);assert.equal(f.calls.length,0);
});

test('self-test consent is account-bound and survives only same-account reopen, while forged marker addresses never forward',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-wa-self-restart-'));
  const first=await fixture(t,{dir,keep:true});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await first.connect();await first.register();
  await first.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  first.socket.ev.emit('messages.upsert',{type:'notify',messages:[first.message('self-before-restart',{key:{id:'self-before-restart',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true}})]});
  await new Promise(resolve=>setImmediate(resolve));await first.bridge.close();
  second=await fixture(t,{dir,keep:true});
  assert.equal(second.bridge.status().inboxScope.includeSelfTests,true);
  await second.bridge.flush();assert.equal(second.callbacks.length,0);assert.equal(second.bridge.status().webhook.pending,1);
  await second.connect();await second.bridge.flush();assert.equal(second.callbacks.length,1);
  assert.equal(JSON.parse(second.callbacks[0].init.body).data.localSelfTest,true);
  const db=new DatabaseSync(join(dir,'bridge.sqlite'));
  const forged={event:'messages.upsert',instance,sourceScope:'all_private_text',data:{key:{id:'forged-self-marker',remoteJid:address,fromMe:false},messageTimestamp:second.message().messageTimestamp,message:{conversation:'［合成測試］錯誤標記'},localSelfTest:true}};
  db.prepare('INSERT INTO callback_outbox(id,event_key,payload,next_at,created_at) VALUES (?,?,?,?,?)').run('forged-self','self-test:forged-self',JSON.stringify(forged),0,0);db.close();
  await second.bridge.flush();assert.equal(second.callbacks.length,1);assert.equal(second.bridge.status().webhook.pending,0);
  second.socket.ev.emit('messages.upsert',{type:'notify',messages:[second.message('self-before-account-change',{key:{id:'self-before-account-change',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:false}})]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(second.bridge.status().webhook.pending,1);
  second.socket.user.id='85255550888:1@s.whatsapp.net';
  assert.equal(second.bridge.status().inboxScope.includeSelfTests,false);assert.equal(second.bridge.status().inboxScope.mode,'test');assert.equal(second.bridge.status().webhook.pending,0);
  assert.equal(second.calls.length,0);
});

test('self-test own LID fallback requires one exact authenticated alias and never guesses unrelated or conflicting LIDs',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  f.socket.user.lid='333333333:1@lid';f.socket.signalRepository.lidMapping.getPNForLID=async()=>null;
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[
    f.message('own-lid-self',{key:{id:'own-lid-self',remoteJid:'333333333:0@lid',fromMe:true}}),
    f.message('unrelated-lid',{key:{id:'unrelated-lid',remoteJid:'999999999@lid',fromMe:false}}),
  ]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  const actual=JSON.parse(f.callbacks[0].init.body);assert.equal(actual.data.localSelfTest,true);assert.equal(actual.data.key.remoteJid,linkedNumber+'@s.whatsapp.net');
  f.socket.user={id:linkedAddress,lid:'444444444@lid'};
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[f.message('ambiguous-own-lid',{key:{id:'ambiguous-own-lid',remoteJid:'333333333@lid',fromMe:true}})]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  assert.equal(f.bridge.status().receiveDiagnostics.rejected.unmapped,2);assert.equal(f.bridge.status().receiveDiagnostics.queued.selfTest,1);
  assert.equal(f.bridge.status().receiveDiagnostics.queued.incoming,0);assert.equal(f.calls.length,0);
});

const selfReplyPath=`/instance/selfTestReply/${instance}`,selfSendPath=`/message/sendSelfTest/${instance}`;
const selfMessage=(f,id,fromMe=true,text='Hello')=>f.message(id,{key:{id,remoteJid:linkedNumber+'@s.whatsapp.net',fromMe},message:{conversation:text}});
async function selfReplyReady(f,{automaticFaq=true}={}){
  await f.connect();await f.register();
  assert.equal((await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true})).status,200);
  const grant=await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq,consent:true});assert.equal(grant.status,200);
  return grant.data;
}
async function selfInput(f,id='self-input',fromMe=true){f.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(f,id,fromMe)]});await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();}
const selfSend=(grant,replyToId='self-input',operationId='self-operation',text='［合成測試］歡迎留言。')=>({text,grantId:grant.grantId,replyToId,operationId,linkPreview:false});

test('self replies default closed, require current account and explicit consent, and never widen ordinary sends',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.api(selfReplyPath)).data,{enabled:false,automaticFaq:false,grantId:null,available:true,requiresNewMessage:true});
  assert.equal((await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true})).status,409);
  assert.equal((await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true},'wrong')).status,401);
  const grant=await selfReplyReady(f);assert.equal(grant.enabled,true);assert.equal(grant.automaticFaq,true);
  assert.doesNotMatch(JSON.stringify(grant),new RegExp(linkedNumber));
  assert.equal(f.bridge.status().testMode.deliveryEnabled,false);assert.equal(f.bridge.status().inboxScope.replyToReceived,false);
  assert.equal((await f.api(`/message/sendText/${instance}`,'POST',{number:linkedNumber,text:'不經這條路線',linkPreview:false})).status,403);
  assert.equal((await f.api(selfSendPath,'POST',selfSend(grant,'not-observed'))).status,403);
  await selfInput(f);
  assert.equal((await f.api(selfSendPath,'POST',{...selfSend(grant),number})).status,400);
  assert.equal((await f.api(selfSendPath,'POST',selfSend({...grant,grantId:'wrong-grant'}))).status,403);
  assert.equal(f.calls.length,0);
  assert.equal((await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:false})).status,409);
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);
});

test('only a new self request carries reply authority and manual operation IDs are durable and idempotent',async t=>{
  const f=await fixture(t);await f.connect();await f.register();
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  await selfInput(f,'old-readonly');assert.equal(normalizeEvent(JSON.parse(f.callbacks.at(-1).init.body),instance).replyGrantId,null);
  const grant=(await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:false,consent:true})).data;
  assert.equal((await f.api(selfSendPath,'POST',selfSend(grant,'old-readonly'))).status,403);
  await selfInput(f,'new-owned-input',false);
  const normalized=normalizeEvent(JSON.parse(f.callbacks.at(-1).init.body),instance);assert.equal(normalized.replyGrantId,grant.grantId);
  const body=selfSend(grant,'new-owned-input','manual-operation');
  const sent=await f.api(selfSendPath,'POST',body);assert.equal(sent.status,201);assert.equal(sent.data.selfTest,true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].jid,linkedNumber+'@s.whatsapp.net');
  const duplicate=await f.api(selfSendPath,'POST',body);assert.equal(duplicate.status,201);assert.equal(duplicate.data.duplicate,true);assert.equal(f.calls.length,1);
  assert.equal((await f.api(selfSendPath,'POST',{...body,text:'另一份內容不可覆寫'})).status,409);assert.equal(f.calls.length,1);
  const db=new DatabaseSync(join(f.dir,'bridge.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_test_inputs WHERE request_id=?').get('old-readonly').n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_test_inputs WHERE request_id=?').get('new-owned-input').n,1);
  assert.equal(db.prepare('SELECT state FROM self_test_operations WHERE operation_id=?').get(body.operationId).state,'accepted');db.close();
});

test('one sourced FAQ-shaped self send is echoed neither as a new true/false input nor an external delivery receipt',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  const sent=await f.api(selfSendPath,'POST',selfSend(grant,'self-input','faq-operation','［合成FAQ］你好，歡迎查詢。'));
  assert.equal(sent.status,201);assert.equal(f.calls.length,1);
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(f,sent.data.key.id,true),selfMessage(f,sent.data.key.id,false)]});
  f.socket.ev.emit('messages.update',[{key:{id:sent.data.key.id,remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true},update:{status:3}}]);
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();
  const upserts=f.callbacks.map(c=>JSON.parse(c.init.body)).filter(c=>c.event==='messages.upsert');assert.equal(upserts.length,1);
  const receipt=f.callbacks.map(c=>JSON.parse(c.init.body)).find(c=>c.event==='messages.update');
  assert.equal(receipt.data.localSelfReply,true);assert.equal(normalizeEvent(receipt,instance).receipts[0].selfTest,true);
  assert.equal(f.bridge.status().receiveDiagnostics.rejected.knownEcho,2);
  assert.equal(f.bridge.status().receiveDiagnostics.queued.incoming,0);
});

test('early provider aliases stay isolated and a failed regrant releases concurrent owner text only as read-only',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  let complete,preallocated;
  f.socket.sendMessage=(jid,content,options)=>{f.calls.push({jid,content,opts:options});preallocated=options.messageId;return new Promise(resolve=>{complete=resolve;});};
  const sending=f.api(selfSendPath,'POST',selfSend(grant));
  while(!complete)await new Promise(resolve=>setImmediate(resolve));
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(f,'provider-alias',true),selfMessage(f,'provider-alias',false),selfMessage(f,preallocated,false),selfMessage(f,'concurrent-owner-input',false,'Hello')]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  assert.equal((await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true})).status,409,'An unresolved send cannot be granted another identity');
  // A failed reconfiguration closes the grant. New unrelated input must remain
  // visible but read-only when the in-flight operation eventually finishes.
  complete({key:{id:'provider-alias'}});assert.equal((await sending).status,201);
  await f.bridge.flush();
  const bodies=f.callbacks.map(c=>JSON.parse(c.init.body));
  assert.equal(bodies.some(c=>c.data?.key?.id==='provider-alias'),false);
  const concurrent=bodies.find(c=>c.data?.key?.id==='concurrent-owner-input');assert.equal(concurrent.data.selfReplyGrantId,null);
  const db=new DatabaseSync(join(f.dir,'bridge.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT send_id FROM local_send_aliases WHERE alias_id=?').get('provider-alias').send_id,preallocated);db.close();
});

test('an unknown self-send outcome closes reply authority and releases isolated echoes only as read-only, never retries',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  let rejectSend;
  f.socket.sendMessage=(jid,content,options)=>{f.calls.push({jid,content,opts:options});return new Promise((resolve,reject)=>{rejectSend=reject;});};
  const body=selfSend(grant),sending=f.api(selfSendPath,'POST',body);
  while(!rejectSend)await new Promise(resolve=>setImmediate(resolve));
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(f,'uncertain-unknown-alias',false)]});await new Promise(resolve=>setImmediate(resolve));
  rejectSend(Error('synthetic unknown outcome'));assert.equal((await sending).status,502);
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);await f.bridge.flush();
  const echoed=f.callbacks.map(c=>JSON.parse(c.init.body)).find(c=>c.data?.key?.id==='uncertain-unknown-alias');assert.equal(echoed.data.selfReplyGrantId,null);
  assert.equal((await f.api(selfSendPath,'POST',body)).status,403);assert.equal(f.calls.length,1);
  const db=new DatabaseSync(join(f.dir,'bridge.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT state FROM self_test_operations WHERE operation_id=?').get(body.operationId).state,'uncertain');db.close();
});

test('a successful alias send drops both early echo forms and releases genuine concurrent owner input under the same grant',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  let finish;
  f.socket.sendMessage=(jid,content,options)=>{f.calls.push({jid,content,opts:options});return new Promise(resolve=>{finish=resolve;});};
  const sending=f.api(selfSendPath,'POST',selfSend(grant));while(!finish)await new Promise(resolve=>setImmediate(resolve));
  f.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(f,'healthy-alias',true),selfMessage(f,'healthy-alias',false),selfMessage(f,'healthy-concurrent-owner',false)]});
  await new Promise(resolve=>setImmediate(resolve));await f.bridge.flush();assert.equal(f.callbacks.length,1);
  finish({key:{id:'healthy-alias'}});assert.equal((await sending).status,201);await f.bridge.flush();
  const bodies=f.callbacks.map(c=>JSON.parse(c.init.body));assert.equal(bodies.some(c=>c.data.key?.id==='healthy-alias'),false);
  assert.equal(bodies.find(c=>c.data.key?.id==='healthy-concurrent-owner').data.selfReplyGrantId,grant.grantId);
  assert.equal((await f.api(selfReplyPath)).data.grantId,grant.grantId);assert.equal(f.calls.length,1);
});

test('a delayed self-grant PUT cannot resurrect authority after an explicit revoke',async t=>{
  const f=await fixture(t);await selfReplyReady(f);
  const held=httpRequest(f.base+selfReplyPath,{method:'PUT',headers:{apikey:key,'Content-Type':'application/json'}});
  const response=new Promise((resolve,reject)=>{held.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});held.on('error',reject);});
  held.write('{"enabled":');await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await f.api(selfReplyPath,'PUT',{enabled:false,automaticFaq:false,consent:true})).status,200);
  held.end('true,"automaticFaq":true,"consent":true}');assert.equal(await response,409);
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);assert.equal(f.calls.length,0);
});

test('a late failure from a disconnected transport cannot revoke a newer process-local self grant',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  let rejectOld;
  const oldSocket=f.socket;oldSocket.sendMessage=()=>new Promise((resolve,reject)=>{rejectOld=reject;});
  const sending=f.api(selfSendPath,'POST',selfSend(grant));while(!rejectOld)await new Promise(resolve=>setImmediate(resolve));
  oldSocket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);
  const connecting=f.api(`/instance/connect/${instance}`);while(f.socket===oldSocket)await new Promise(resolve=>setImmediate(resolve));
  f.socket.ev.emit('connection.update',{connection:'open'});await connecting;
  const next=(await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:false,consent:true})).data;assert.equal(next.enabled,true);assert.notEqual(next.grantId,grant.grantId);
  rejectOld(Error('synthetic late transport failure'));assert.equal((await sending).status,502);
  assert.equal((await f.api(selfReplyPath)).data.grantId,next.grantId);
});

test('self grants close on scope change, disconnect and account changes; new grants cannot authorize old inputs',async t=>{
  const f=await fixture(t);let grant=await selfReplyReady(f);await selfInput(f);
  await f.api(`/instance/inboxScope/${instance}`,'PUT',{mode:'all_private_text',includeSelfTests:true,consent:true});
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);
  assert.equal((await f.api(selfSendPath,'POST',selfSend(grant))).status,403);
  const next=(await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true})).data;assert.notEqual(next.grantId,grant.grantId);
  assert.equal((await f.api(selfSendPath,'POST',selfSend(next))).status,403);
  f.socket.user.id='85255550999:1@s.whatsapp.net';assert.equal((await f.api(selfReplyPath)).data.enabled,false);
  assert.equal((await f.api(selfSendPath,'POST',selfSend(next))).status,403);assert.equal(f.calls.length,0);
});

test('self-send IDs survive restart but grants and old request authority never do',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-self-reply-restart-'));
  const first=await fixture(t,{dir,keep:true});let second;
  t.after(async()=>{await first.bridge.close();await second?.bridge.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const grant=await selfReplyReady(first);await selfInput(first);
  const sent=await first.api(selfSendPath,'POST',selfSend(grant));assert.equal(sent.status,201);await first.bridge.close();
  second=await fixture(t,{dir,keep:true});await second.connect();await second.register();
  assert.equal((await second.api(selfReplyPath)).data.enabled,false);
  assert.equal((await second.api(selfSendPath,'POST',selfSend(grant))).status,403);
  const next=(await second.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true})).data;assert.notEqual(next.grantId,grant.grantId);
  second.socket.ev.emit('messages.upsert',{type:'notify',messages:[selfMessage(second,sent.data.key.id,true),selfMessage(second,sent.data.key.id,false),selfMessage(second,'self-input',false)]});
  await new Promise(resolve=>setImmediate(resolve));await second.bridge.flush();assert.equal(second.callbacks.length,0);assert.equal(second.calls.length,0);
  assert.equal((await second.api(selfSendPath,'POST',selfSend(next))).status,403);
});

test('self sending has a separate five-per-minute ceiling and does not auto-retry rate-limited operations',async t=>{
  const f=await fixture(t),grant=await selfReplyReady(f);await selfInput(f);
  for(let i=0;i<5;i++)assert.equal((await f.api(selfSendPath,'POST',selfSend(grant,'self-input','rate-'+i))).status,201);
  assert.equal((await f.api(selfSendPath,'POST',selfSend(grant,'self-input','rate-six'))).status,429);assert.equal(f.calls.length,5);
  assert.equal((await f.api(selfReplyPath)).data.enabled,false);
  f.advance(60000);const next=(await f.api(selfReplyPath,'PUT',{enabled:true,automaticFaq:true,consent:true})).data;await selfInput(f,'new-rate-input');
  assert.equal((await f.api(selfSendPath,'POST',selfSend(next,'new-rate-input','rate-six'))).status,201);assert.equal(f.calls.length,6);
});

test('self provider transport is explicit, contains no recipient, and normalizes grant and receipt markers strictly',async()=>{
  const calls=[];const provider=createEvolution({url:'http://127.0.0.1:3199',instance:'self fixture',apiKey:'synthetic-only',deliveryEnabled:false,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({key:{id:'self-provider-id'},status:'accepted',selfTest:true}));}});
  const input={text:'［合成測試］本人手動回覆。',grantId:'synthetic-grant',replyToId:'synthetic-input',operationId:'synthetic-operation'};
  assert.deepEqual(await provider.sendSelfTest(input),{providerId:'self-provider-id',selfTest:true,duplicate:false});
  assert.match(calls[0].url,/\/message\/sendSelfTest\/self%20fixture$/);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.apikey,'synthetic-only');
  assert.deepEqual(JSON.parse(calls[0].options.body),{...input,linkPreview:false});assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(provider.sendSelfTest({...input,number}),/SELF_TEST_INPUT_INVALID/);assert.equal(calls.length,1);
  await assert.rejects(provider.send(address,'普通發送仍關閉'),/DELIVERY_DISABLED/);
  const base={event:'messages.upsert',instance,data:{key:{id:'synthetic-self-event',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:false},messageTimestamp:Date.now()/1000,message:{conversation:'Hello'},localSelfTest:true,selfReplyGrantId:'synthetic-grant'}};
  assert.equal(normalizeEvent(base,instance).replyGrantId,'synthetic-grant');
  assert.equal(normalizeEvent({...base,data:{...base.data,selfReplyGrantId:{bad:true}}},instance).kind,'ignore');
  const receipt={event:'messages.update',instance,data:{keyId:'self-provider-id',remoteJid:linkedNumber+'@s.whatsapp.net',fromMe:true,status:'DELIVERY_ACK',localSelfReply:true}};
  assert.equal(normalizeEvent(receipt,instance).receipts[0].selfTest,true);
});
