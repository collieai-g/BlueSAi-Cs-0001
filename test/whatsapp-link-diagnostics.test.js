import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';

function fixture(t,initial) {
  const store=new Store(':memory:'),engine=new Engine(store,createAgent(),createEvolution());
  let response=initial;
  const connections=createConnections({store,engine,fetchImpl:async()=>Response.json(response)});
  t.after(()=>store.close());
  return {connections,engine,set:value=>{response=value;},connect:()=>connections.whatsapp({url:'https://provider.example.test',instance:'synthetic',apiKey:'synthetic-key'})};
}

test('bluesai-whatsapp-link-001: expired login is distinguished from QR waiting and never exposes provider text',async t=>{
  const f=fixture(t,{instance:{state:'close'},lastReason:'logged_out',qrAvailable:false,qrExpiresInMs:0,error:'synthetic-private-provider-error',credentials:'synthetic-private-credentials'});
  const result=await f.connect();
  assert.equal(result.status,'close');assert.equal(result.lastReason,'logged_out');assert.equal(result.qr,null);assert.equal(result.qrAvailable,false);
  assert.match(result.message,/登入授權已失效/);assert.match(result.message,/安裝人員/);assert.match(result.message,/不要反覆掃碼/);
  assert.equal(f.connections.status().whatsapp.lastReason,'logged_out');
  assert.doesNotMatch(JSON.stringify([result,f.connections.status()]),/synthetic-private/);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  const checked=await f.connections.checkWhatsApp();assert.equal(checked.lastReason,'logged_out');assert.match(checked.message,/登入授權已失效/);
  f.set({instance:{state:'close'},lastReason:'synthetic-private-arbitrary-error'});
  const unknown=await f.connections.checkWhatsApp();assert.equal(unknown.lastReason,'');assert.doesNotMatch(JSON.stringify([unknown,f.connections.status()]),/synthetic-private/);
});

test('bluesai-whatsapp-link-001: QR lifetime is bounded and open or closed responses never expose a stale QR',async t=>{
  const qr='data:image/png;base64,c3ludGhldGlj';
  const f=fixture(t,{instance:{state:'connecting'},base64:qr,qrAvailable:true,qrExpiresInMs:12345});
  const first=await f.connect();assert.equal(first.qr,qr);assert.equal(first.qrExpiresInMs,12345);
  f.set({instance:{state:'connecting'},qrAvailable:false});
  const expired=await f.connections.checkWhatsApp();assert.equal(expired.qrAvailable,false);assert.match(expired.message,/已失效/);
  f.set({instance:{state:'connecting'},base64:qr,qrAvailable:false,qrExpiresInMs:0});
  const unavailable=await f.connect();assert.equal(unavailable.qr,null);assert.equal(unavailable.qrAvailable,false);
  f.set({instance:{state:'open'},base64:qr,lastReason:'logged_out',qrExpiresInMs:20000});
  const open=await f.connect();assert.equal(open.qr,null);assert.equal(open.qrAvailable,false);assert.equal(open.lastReason,'');assert.equal(open.qrExpiresInMs,0);
  f.set({instance:{state:'close'},base64:qr,qrExpiresInMs:20001});
  const closed=await f.connect();assert.equal(closed.qr,null);assert.equal(closed.qrAvailable,false);assert.equal('qrExpiresInMs' in closed,false);
});

test('bluesai-whatsapp-link-001: only fixed connection failures reach the user and success clears old failure',async t=>{
  const f=fixture(t,{instance:{state:'close'}});await f.connect();
  for(const reason of ['account_not_available','connection_closed','reconnect_failed','credential_save_failed','connection_start_failed','qr_encoding_failed']){
    f.set({instance:{state:'close'},lastReason:reason});
    const result=await f.connections.checkWhatsApp();assert.equal(result.lastReason,reason);assert.notEqual(result.message,'手機尚未連接，請重新取得二維碼。');
  }
  f.set({instance:{state:'open'},lastReason:'logged_out',qrAvailable:true});
  const open=await f.connections.checkWhatsApp();assert.equal(open.lastReason,'');assert.equal(open.qrAvailable,false);
});

test('bluesai-whatsapp-link-001: a legacy provider without QR metadata retains waiting compatibility',async t=>{
  const qr='data:image/png;base64,c3ludGhldGlj';
  const f=fixture(t,{base64:qr});
  const first=await f.connect();assert.equal(first.status,'connecting');assert.equal(first.qrAvailable,true);assert.equal('qrExpiresInMs' in first,false);
  f.set({instance:{state:'connecting'}});
  const waiting=await f.connections.checkWhatsApp();assert.equal(waiting.qrAvailable,true);assert.match(waiting.message,/等待手機連接/);assert.equal('qrExpiresInMs' in waiting,false);
  f.set({instance:{state:'close'}});
  assert.equal((await f.connections.checkWhatsApp()).qrAvailable,false);
});
