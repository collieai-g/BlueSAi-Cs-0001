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
  const bridge=createLocalBridge({dataDir:dir,instance,apiKey:key,webhookUrl:webhook.url,webhookSecret:secret,allowTestActivation:true,flushIntervalMs:60000,
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
  f.socket.ev.emit('messages.upsert',{type:'append',messages:[f.message('history')]});
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
