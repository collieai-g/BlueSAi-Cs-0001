import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the shipped handlers against a tiny DOM and synthetic provider only.
const source=readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8');
const start=source.indexOf('    let whatsappQrTimer=null,whatsappQrGeneration=0;');
const end=source.indexOf("    find('[data-whatsapp-form]').addEventListener",start);
const phoneStart=source.indexOf('    function phoneConnectionState(');
const phoneEnd=source.indexOf('    function paintPhoneConnection(',phoneStart);
assert.ok(start>=0&&end>start&&phoneStart>=0&&phoneEnd>phoneStart,'actual QR and linear connection handlers are present');
const handlers=source.slice(phoneStart,phoneEnd)+'\n'+source.slice(start,end);

function node(dataset={}){
  return {dataset,hidden:false,disabled:false,textContent:'',children:[],attributes:{},
    setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},
    replaceChildren(){this.children=[];},append(child){this.children.push(child);},querySelectorAll(){return [];}};
}
function fixture(options={}){
  const nodes=new Map();
  for(const name of ['qr-box','qr-image','wa-result','wa-link-flow','wa-link-title','wa-link-status','wa-link-phone','wa-link-scan-help','wa-link-retry','wa-link-cancel','whatsapp-form','service-check'])nodes.set('[data-'+name+']',node());
  nodes.set('[data-prepare-setup="whatsapp"]',node());
  const stages=[0,1,2,3].map(step=>node({waLinkStage:String(step)}));
  const box=nodes.get('[data-qr-box]'),image=nodes.get('[data-qr-image]');image.children=[{src:'synthetic-old-image'}];
  const timers=new Map(),cleared=new Set(),calls={request:0,check:0,load:0,prepare:0,preparation:0,qr:0,refresh:0,reports:[]};let nextTimer=0;
  let wa={status:'unconfigured',localPreparationAvailable:options.local!==false,...(options.wa||{})};
  const form={values:{url:'http://127.0.0.1:3199',instance:'synthetic'},elements:{apiKey:{value:''}},details:{open:false},querySelector(){return this.details;}};
  const markReady=()=>{wa={...wa,status:'configured',url:'http://127.0.0.1:3199',instance:'synthetic'};};
  const context={
    live:true,busy:false,root:{isConnected:true},guideFlow:'whatsapp',setupTaskFlow:null,
    state:{screen:'config',tab:'connect',managementSection:'channels'},
    whatsappLink:{phase:'idle',message:'',active:false,epoch:0,timer:null,startedAt:0,qrUntil:0,args:{}},
    snapshot:{connections:{mode:'preview',whatsapp:wa}},
    find:selector=>{assert.ok(nodes.has(selector),'known DOM selector '+selector);return nodes.get(selector);},
    all:selector=>{assert.equal(selector,'[data-wa-link-stage]');return stages;},
    document:{createElement:tag=>({tagName:tag})},
    FormData:class{constructor(value){this.values=value.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}},
    backend:{
      whatsapp:async args=>{calls.request++;const result=await(options.whatsapp?.(args)??{status:'connecting',qrAvailable:true,qr:'synthetic-new-image',qrExpiresInMs:20000});wa={...wa,status:result.status,qrAvailable:result.qrAvailable};return result;},
      checkWhatsApp:async()=>{calls.check++;const result=await(options.check?.(calls.check)??{status:'connecting',qrAvailable:true});wa={...wa,...result,...(result.status==='open'?{checkedAt:Date.now()}: {})};return result;},
      load:async()=>{calls.load++;return {connections:{mode:'preview',whatsapp:options.readBack?.(wa)??{...wa}}};},
      getWhatsAppQr:async()=>{calls.qr++;return options.qr?.()??{status:'connecting',qrAvailable:true,qr:'synthetic-refreshed-image',qrExpiresInMs:20000};},
      configureWhatsAppInboxScope:()=>assert.fail('linking a phone must never grant message reception or replies'),
      registerWebhook:()=>assert.fail('phone-only linking must not register a receiver'),
    },
    paintData:()=>{context.syncWhatsAppQr(context.snapshot.connections.whatsapp);context.paintWhatsAppLink();},paintGuide:()=>{},
    refresh:async()=>{calls.refresh++;},report:value=>calls.reports.push(value),
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>{if(id!==null)cleared.add(id);},
  };
  if(options.local!==false){
    context.backend.prepareWhatsAppLocal=async()=>{calls.prepare++;const result=await(options.prepare?.()??{status:'ready'});if(result.status==='ready')markReady();return result;};
    context.backend.getWhatsAppLocal=async()=>{calls.preparation++;const result=await(options.preparation?.()??{status:'ready'});if(result.status==='ready')markReady();return result;};
  }
  runInNewContext(handlers,context,{filename:'actual-workbench-whatsapp-flow.js'});
  const next=async ms=>{const entry=[...timers].find(([id,timer])=>!cleared.has(id)&&timer.ms===ms);assert.ok(entry,'scheduled timer '+ms);cleared.add(entry[0]);await entry[1].fn();};
  return {context,calls,form,timers,cleared,nodes,stages,next,box,image,notice:nodes.get('[data-wa-result]')};
}
const assertCleared=f=>{assert.equal(f.box.hidden,true);assert.equal(f.image.children.length,0);};

test('wiring and painting never prepare, connect or enable message permissions',()=>{
  const f=fixture();f.context.paintWhatsAppLink();
  assert.equal(f.calls.prepare,0);assert.equal(f.calls.request,0);assert.equal(f.calls.check,0);
  assert.equal(f.context.whatsappLink.phase,'idle');
});

test('one click prepares privately, shows the real QR and confirms the read-back linked phone',async()=>{
  const f=fixture({prepare:()=>({status:'preparing'}),check:count=>count===1?{status:'connecting',qrAvailable:true}:{status:'open',linkedPhone:'15555550123'}});
  await f.context.startWhatsAppLink();assertCleared(f);assert.equal(f.calls.prepare,1);assert.equal(f.calls.request,0);
  assert.equal(f.context.whatsappLink.phase,'preparing');
  await f.next(1000);assert.equal(f.calls.preparation,1);assert.equal(f.calls.request,1);
  assert.equal(f.box.hidden,false);assert.equal(f.image.children[0].src,'synthetic-new-image');assert.equal(f.context.whatsappLink.phase,'waiting');
  await f.next(2000);assert.equal(f.context.whatsappLink.phase,'connected');assert.equal(f.context.whatsappLink.active,false);assertCleared(f);
  assert.equal(f.nodes.get('[data-wa-link-phone]').textContent,'+15555550123');assert.equal(f.nodes.get('[data-wa-link-title]').textContent,'手機已接駁');
  assert.equal(f.calls.request,1,'polling success does not request another connection');
});

test('an existing verified authorization reconnects without asking for another QR',async()=>{
  const f=fixture({local:false,wa:{status:'configured',url:'https://synthetic.invalid',instance:'synthetic'},check:()=>({status:'open',linkedPhone:'15555550123'})});
  await f.context.startWhatsAppLink();assert.equal(f.context.whatsappLink.phase,'connected');
  assert.equal(f.calls.prepare,0);assert.equal(f.calls.request,0);assertCleared(f);
});

test('runtime and host capabilities preserve configured loopback services without calling local preparation',async()=>{
  const f=fixture({wa:{status:'configured',url:'http://127.0.0.1:3198',instance:'synthetic-existing',localPreparationAvailable:false},prepare:()=>assert.fail('an existing runtime must not prepare a preview bridge'),check:()=>({status:'open',linkedPhone:'15555550123'})});
  await f.context.startWhatsAppLink();assert.equal(f.context.whatsappLink.phase,'connected');assert.equal(f.calls.prepare,0);assert.equal(f.calls.request,0);
  const missing=fixture({wa:{localPreparationAvailable:false},prepare:()=>assert.fail('unsupported host must not prepare a preview bridge')});
  await missing.context.startWhatsAppLink();assert.equal(missing.context.whatsappLink.phase,'error');assert.equal(missing.calls.prepare,0);assert.equal(missing.calls.request,0);assert.match(missing.nodes.get('[data-wa-link-status]').textContent,/此環境未提供/);
});

test('an open response without verified state read-back stops without starting another connection',async()=>{
  for(const readBack of [wa=>({...wa,checkedAt:undefined}),wa=>({...wa,requiresCheck:true})]){
    const f=fixture({check:()=>({status:'open',linkedPhone:'15555550123'}),readBack});
    await f.context.startWhatsAppLink();
    assert.equal(f.context.whatsappLink.phase,'error');assert.equal(f.nodes.get('[data-wa-link-phone]').hidden,true);assertCleared(f);
    assert.equal(f.calls.request,0,'a provider already reporting open must not be reconnected when its verification is missing');
    assert.match(f.nodes.get('[data-wa-link-status]').textContent,/讀回確認/);
  }
});

test('unsupported preparation and provider errors give an explicit retry without silently connecting',async()=>{
  const unsupported=fixture({local:false});await unsupported.context.startWhatsAppLink();
  assert.equal(unsupported.context.whatsappLink.phase,'error');assert.equal(unsupported.calls.request,0);
  assert.match(unsupported.nodes.get('[data-wa-link-status]').textContent,/進階設定/);
  const failed=fixture({prepare:async()=>{throw new Error('synthetic-preparation-unavailable');}});
  await failed.context.startWhatsAppLink();assertCleared(failed);assert.equal(failed.context.whatsappLink.phase,'error');
  assert.equal(failed.nodes.get('[data-wa-link-retry]').hidden,false);assert.equal(failed.calls.request,0);
});

test('repeated clicks are single flight and stopping ignores late preparation without deleting authorization',async()=>{
  let resolve;const f=fixture({prepare:()=>new Promise(done=>{resolve=done;})});
  const pending=f.context.startWhatsAppLink();await f.context.startWhatsAppLink();assert.equal(f.calls.prepare,1);
  f.context.stopWhatsAppLink();assertCleared(f);assert.equal(f.context.whatsappLink.phase,'cancelled');
  resolve({status:'ready'});await pending;
  assert.equal(f.calls.request,0);assert.equal(f.calls.check,0);assert.equal(f.context.whatsappLink.phase,'cancelled');
});

test('a late cancelled QR request cannot clear a newer manual connection or replace its QR',async()=>{
  let resolveOld,resolveNew;const captured=[];
  const f=fixture({whatsapp:args=>{captured.push(args);return new Promise(done=>{if(captured.length===1)resolveOld=done;else resolveNew=done;});}});
  const first=f.context.startWhatsAppLink({url:'https://synthetic-a.invalid',instance:'a',apiKey:'synthetic-a-secret'});
  while(f.calls.request<1)await Promise.resolve();
  f.context.stopWhatsAppLink();
  const newer={url:'https://synthetic-b.invalid',instance:'b',apiKey:'synthetic-b-secret'};
  const second=f.context.startWhatsAppLink(newer);
  while(f.calls.request<2)await Promise.resolve();
  resolveOld({status:'connecting',qr:'synthetic-old-late-qr',qrAvailable:true});await first;
  assert.equal(f.context.whatsappLink.args.apiKey,'synthetic-b-secret');assert.equal(f.context.whatsappLink.manualArgs,newer);assertCleared(f);
  resolveNew({status:'connecting',qr:'synthetic-current-qr',qrAvailable:true});await second;
  assert.equal(f.image.children[0].src,'synthetic-current-qr');assert.equal(f.context.whatsappLink.args.apiKey,undefined);
});

test('expired local QR refresh uses only the read-only QR API and never restarts a socket',async()=>{
  const f=fixture();await f.context.startWhatsAppLink();assert.equal(f.calls.request,1);
  f.context.clearWhatsAppQr();await f.next(2000);
  assert.equal(f.calls.qr,1);assert.equal(f.calls.request,1);assert.equal(f.image.children[0].src,'synthetic-refreshed-image');
  const raced=fixture({qr:()=>({status:'close',qrAvailable:false,qr:null,message:'synthetic-close-during-refresh'})});
  await raced.context.startWhatsAppLink();raced.context.clearWhatsAppQr();await raced.next(2000);
  assert.equal(raced.context.whatsappLink.phase,'error');assert.equal(raced.calls.request,1);assertCleared(raced);
});

test('an existing runtime bridge refreshes its QR only when the runtime declares local-test support',async()=>{
  for(const supported of [true,false]){
    const f=fixture({local:false,wa:{status:'configured',url:'http://127.0.0.1:3198',instance:'synthetic-existing',localPreparationAvailable:false,localTest:supported}});
    await f.context.startWhatsAppLink();
    assert.equal(f.calls.prepare,0,'the original runtime must not prepare a separate preview manager');
    assert.equal(f.context.whatsappLink.local,false);
    assert.equal(f.calls.request,1);
    f.context.clearWhatsAppQr();await f.next(2000);
    assert.equal(f.calls.qr,supported?1:0,'read-only QR refresh requires an explicit supported bridge capability');
    assert.equal(f.calls.request,1,'refresh must not create a second connection or replace the original account');
    if(supported)assert.equal(f.image.children[0].src,'synthetic-refreshed-image');
    else assertCleared(f);
  }
});

test('closed or logged-out polling stops and cannot fetch QR or retry the connection',async()=>{
  const f=fixture({check:count=>count===1?{status:'connecting',qrAvailable:true}:{status:'close',qrAvailable:false,lastReason:'logged_out',message:'synthetic-logged-out'}});
  await f.context.startWhatsAppLink();await f.next(2000);
  assert.equal(f.context.whatsappLink.phase,'error');assert.equal(f.calls.qr,0);assert.equal(f.calls.request,1);assertCleared(f);
});

test('bounded waiting and navigation stop polling while retaining unsaved form values',async()=>{
  const f=fixture();await f.context.startWhatsAppLink();f.context.whatsappLink.startedAt=Date.now()-180001;await f.next(2000);
  assert.equal(f.context.whatsappLink.phase,'error');assert.equal(f.calls.request,1);assertCleared(f);
  const nav=fixture();await nav.context.startWhatsAppLink();nav.form.values.instance='synthetic-unsaved';nav.context.state.managementSection='merchant';await nav.next(2000);
  assert.equal(nav.context.whatsappLink.phase,'cancelled');assert.equal(nav.calls.check,1);assert.equal(nav.form.values.instance,'synthetic-unsaved');assertCleared(nav);
});

test('preparation has a finite wait and an explicit retry reads the existing job again',async()=>{
  const f=fixture({prepare:()=>({status:'preparing'})});await f.context.startWhatsAppLink();
  f.context.whatsappLink.preparationAt=Date.now()-600001;await f.next(1000);
  assert.equal(f.context.whatsappLink.phase,'error');assert.equal(f.calls.request,0);
  await f.context.startWhatsAppLink();assert.equal(f.calls.prepare,2);assert.equal(f.context.whatsappLink.phase,'preparing');
});

test('manual connection checks clear unavailable images without requesting another socket',async()=>{
  for(const result of [{status:'close',qrAvailable:false},{status:'connecting',qrAvailable:false},{status:'open'},{status:'unknown'}]){
    const f=fixture({check:()=>result});await f.context.checkWhatsAppConnection();assertCleared(f);
    assert.equal(f.calls.request,0);assert.equal(f.calls.check,1);
  }
});

test('manual service configuration remains explicit and clears the input secret',async()=>{
  const f=fixture();f.form.values.apiKey='synthetic-only-secret';f.form.elements.apiKey.value='synthetic-only-secret';
  await f.context.requestWhatsAppQr(f.form);assert.equal(f.calls.prepare,0);assert.equal(f.calls.request,1);
  assert.equal(f.form.elements.apiKey.value,'');assert.equal(f.context.whatsappLink.args.apiKey,undefined);
  const invalid=fixture();invalid.form.values.url='';await assert.rejects(invalid.context.requestWhatsAppQr(invalid.form),/服務網址/);assertCleared(invalid);assert.equal(invalid.calls.request,0);
});

test('missing, expired or disconnected QR responses cannot display an image',()=>{
  for(const result of [{status:'connecting',qr:null},{status:'connecting',qr:'synthetic',qrAvailable:false},{status:'connecting',qr:'synthetic',qrExpiresInMs:0},{status:'close',qr:'synthetic'},{status:'open',qr:'synthetic'}]){
    const f=fixture();f.context.showWhatsAppQr(result);assertCleared(f);
  }
});

test('server expiry clears only the image and late timers cannot erase a replacement',()=>{
  const f=fixture();f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-first',qrExpiresInMs:1000});
  const old=f.timers.get(1);f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-second',qrExpiresInMs:2000});
  assert.equal(f.cleared.has(1),true);old.fn();assert.equal(f.image.children[0].src,'synthetic-second');
  f.timers.get(2).fn();assertCleared(f);assert.equal(f.calls.request,0);assert.equal(f.calls.qr,0);
});

test('ordinary providers without a valid expiry do not get an invented QR lifetime',()=>{
  for(const expiry of [undefined,null,-1,0.5,20001,'1000']){
    const f=fixture();f.context.showWhatsAppQr({status:'connecting',qr:'synthetic-provider-image',qrExpiresInMs:expiry});assert.equal(f.box.hidden,false);assert.equal(f.timers.size,0);
  }
  const f=fixture();f.context.syncWhatsAppQr({status:'connecting',qrAvailable:false});assertCleared(f);
});
