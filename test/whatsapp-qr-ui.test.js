import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the actual card handlers with a tiny DOM, without a browser, provider,
// credentials or startup of the unrelated inbox/UI components.
const source=readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8');
const start=source.indexOf('    let whatsappQrTimer=null,whatsappQrGeneration=0;');
const end=source.indexOf("    find('[data-whatsapp-form]').addEventListener",start);
assert.ok(start>=0&&end>start,'actual WhatsApp UI handlers are present');
const handlers=source.slice(start,end);

function fixture(options={}){
  const nodes=new Map([
    ['[data-qr-box]',{hidden:false}],
    ['[data-qr-image]',{children:[{src:'synthetic-old-image'}],replaceChildren(){this.children=[];},append(node){this.children.push(node);}}],
    ['[data-wa-result]',{textContent:''}],
  ]);
  const timers=new Map(),cleared=new Set(),calls={request:0,check:0,refresh:0};let nextTimer=0;
  const form={values:{url:'http://127.0.0.1:3199',instance:'synthetic'},elements:{apiKey:{value:''}},details:{open:false},querySelector(){return this.details;}};
  const context={
    find:selector=>{assert.ok(nodes.has(selector),selector);return nodes.get(selector);},
    document:{createElement:tag=>({tagName:tag})},
    FormData:class{constructor(value){this.values=value.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}},
    backend:{whatsapp:async args=>{calls.request++;return options.whatsapp?.(args)??{status:'connecting',qr:'synthetic-new-image',message:'synthetic-ready'};},checkWhatsApp:async()=>{calls.check++;return options.check?.()??{status:'close',qrAvailable:false,message:'synthetic-closed'};}},
    refresh:async()=>{calls.refresh++;await options.refresh?.();},report:()=>{},
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>{if(id!==null)cleared.add(id);},
  };
  runInNewContext(handlers,context,{filename:'actual-workbench-qr-handlers.js'});
  return {context,calls,form,timers,cleared,box:nodes.get('[data-qr-box]'),image:nodes.get('[data-qr-image]'),notice:nodes.get('[data-wa-result]')};
}

function assertCleared(f){assert.equal(f.box.hidden,true);assert.equal(f.image.children.length,0);}

test('a pending QR request immediately removes the old image and only shows the returned new QR',async()=>{
  let resolve;
  const f=fixture({whatsapp:()=>new Promise(done=>{resolve=done;})});
  const pending=f.context.requestWhatsAppQr(f.form);
  assertCleared(f);assert.equal(f.calls.request,1);
  resolve({status:'connecting',qrAvailable:true,qr:'synthetic-current-image',message:'synthetic-ready'});
  await pending;
  assert.equal(f.box.hidden,false);assert.equal(f.image.children.length,1);assert.equal(f.image.children[0].src,'synthetic-current-image');
});

test('missing configuration and failed QR requests leave no old image',async()=>{
  const invalid=fixture();invalid.form.values.url='';
  await assert.rejects(invalid.context.requestWhatsAppQr(invalid.form),/服務尚未準備好/);
  assertCleared(invalid);assert.equal(invalid.calls.request,0);assert.equal(invalid.form.details.open,true);
  const failed=fixture({whatsapp:async()=>{throw new Error('synthetic-unavailable');}});
  await assert.rejects(failed.context.requestWhatsAppQr(failed.form),/synthetic-unavailable/);
  assertCleared(failed);assert.equal(failed.notice.textContent,'synthetic-unavailable');
});

test('missing, expired or disconnected QR responses cannot retain or display an image',async()=>{
  for(const result of [
    {status:'connecting',qr:null},
    {status:'connecting',qr:'synthetic-image',qrAvailable:false},
    {status:'connecting',qr:'synthetic-image',qrExpiresInMs:0},
    {status:'close',qr:'synthetic-image',lastReason:'logged_out'},
    {status:'open',qr:'synthetic-image'},
  ]){
    const f=fixture({whatsapp:async()=>({...result,message:'synthetic-result'})});
    await f.context.requestWhatsAppQr(f.form);assertCleared(f);
  }
});

test('connection checks remove closed, unavailable or unknown QR images without starting a socket',async()=>{
  for(const result of [{status:'close',qrAvailable:false},{status:'connecting',qrAvailable:false},{status:'open'},{status:'unknown'}]){
    const f=fixture({check:async()=>({...result,message:'synthetic-check'})});
    await f.context.checkWhatsAppConnection();assertCleared(f);assert.equal(f.calls.request,0);assert.equal(f.calls.check,1);
  }
  const waiting=fixture({check:async()=>({status:'connecting',qrAvailable:true,message:'synthetic-waiting'})});
  await waiting.context.checkWhatsAppConnection();assert.equal(waiting.box.hidden,false);assert.equal(waiting.image.children.length,1);
  const failed=fixture({check:async()=>{throw new Error('synthetic-check-failed');}});
  await assert.rejects(failed.context.checkWhatsAppConnection(),/synthetic-check-failed/);assertCleared(failed);
});

test('server-supplied expiry only removes the QR and never reconnects',()=>{
  const f=fixture();f.context.showWhatsAppQr({status:'connecting',qrAvailable:true,qr:'synthetic-current-image',qrExpiresInMs:1234});
  assert.equal(f.timers.size,1);const timer=f.timers.get(1);assert.equal(timer.ms,1234);
  timer.fn();assertCleared(f);assert.match(f.notice.textContent,/二維碼已失效/);assert.equal(f.calls.request,0);assert.equal(f.calls.check,0);
});

test('replacing a QR cancels its old timer and a late callback cannot erase the new image',()=>{
  const f=fixture();f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-first-image',qrExpiresInMs:1000});
  const old=f.timers.get(1);f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-second-image',qrExpiresInMs:2000});
  assert.equal(f.cleared.has(1),true);old.fn();assert.equal(f.box.hidden,false);assert.equal(f.image.children[0].src,'synthetic-second-image');
  f.timers.get(2).fn();assertCleared(f);
});

test('ordinary providers without a valid expiry do not get an invented QR lifetime',()=>{
  for(const expiry of [undefined,null,-1,0.5,20001,'1000']){
    const f=fixture();f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-provider-image',qrExpiresInMs:expiry});
    assert.equal(f.box.hidden,false);assert.equal(f.timers.size,0);
  }
  const f=fixture();f.context.syncWhatsAppQr({status:'connecting',qrAvailable:false});assertCleared(f);
});
