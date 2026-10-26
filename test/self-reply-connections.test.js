import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';

const basePath='/api/agents/bluesai-cs-0001',secret='synthetic-self-scope-secret-'.repeat(2);
const provider={url:'http://127.0.0.1:31999',instance:'synthetic-self',apiKey:'synthetic-self-key'};
async function fixture(t){
  const store=new Store(':memory:'),engine=new Engine(store,{configured:false},{configured:false});
  let grant=0,failRead=false,bridge={available:true,enabled:false,automaticFaq:false,grantId:null,requiresNewMessage:true};
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({path,method:options.method||'GET'});
    let value;
    if(path.includes('/selfTestReply/')){
      if(options.method==='PUT'){const input=JSON.parse(options.body);bridge={...bridge,enabled:input.enabled,automaticFaq:input.enabled&&input.automaticFaq,grantId:input.enabled?'synthetic-grant-'+(++grant):null};}
      if(failRead&&options.method!=='PUT')return new Response('{}',{status:503});
      value=bridge;
    }else if(path.includes('/connectionState/'))value={instance:{state:'open'}};
    else if(path.includes('/inboxScope/'))value={mode:'all_private_text',consented:true,includeSelfTests:true,replyToReceived:true};
    else if(path.includes('/webhook/find/'))value={enabled:true,url:'http://127.0.0.1:3100/webhooks/evolution',headers:{Authorization:'Bearer '+secret},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']};
    else throw Error('Unexpected fixture request '+path);
    return new Response(JSON.stringify(value));
  };
  const workbench=createConnections({store,engine,fetchImpl,runtime:true,localWhatsAppTest:true,providerConfig:provider,publicBaseUrl:'http://127.0.0.1:3100',webhookSecret:secret});
  const server=createApp({store,engine,workbench,runtimeMode:true,webhookSecret:secret,adminToken:secret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const login=await fetch(origin+basePath+'/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:secret})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const api=async(path,method='GET',input)=>{const r=await fetch(origin+basePath+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});return {status:r.status,data:await r.json()};};
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await engine.stop();store.close();});
  return {store,engine,workbench,api,calls,failRead:()=>{failRead=true;},bridge:()=>bridge};
}

test('owner namespaced self reply scope is explicit and read-back verified without enabling general delivery',async t=>{
  const f=await fixture(t),path='/connections/whatsapp-self-test-reply';
  assert.equal((await f.api(path)).data.enabled,false);
  assert.equal((await f.api(path,'POST',{enabled:true,automaticFaq:true})).status,400);
  const enabled=await f.api(path,'POST',{enabled:true,automaticFaq:true,consent:true});
  assert.equal(enabled.status,200);assert.equal(enabled.data.enabled,true);
  assert.equal(f.engine.selfReply.grantId,f.bridge().grantId);
  assert.equal(f.engine.evolution.deliveryEnabled,false);
  assert.equal(f.workbench.status().whatsapp.selfTestReply.enabled,true);
  const event={address:'85255550199@s.whatsapp.net',eventId:'new-self-input',text:'new text',timestamp:Date.now(),replyGrantId:f.bridge().grantId};
  const r=f.engine.receiveSelfTest(event),detail=await f.api('/conversations/'+r.conversationId);
  assert.equal(detail.data.selfTestReply.eligible,true);
  const manual=await f.api('/conversations/'+r.conversationId+'/self-test-reply','POST',{text:'合成本人測試',operationId:'synthetic-manual-operation',expectedVersion:detail.data.conversation.version});
  assert.equal(manual.status,201);assert.equal(manual.data.sent,false);
  assert.equal(f.store.messages(r.conversationId).at(-1).operation_id,'synthetic-manual-operation');
  const context=(await f.api('/inbox/context?conversationId='+r.conversationId)).data;
  assert.equal(context.conversation.readOnly,true);assert.equal(context.selfTestReply.eligible,true);
  await f.api(path,'POST',{enabled:false,automaticFaq:false,consent:true});
  assert.equal(f.engine.selfReply.enabled,false);assert.equal(f.store.messages(r.conversationId).at(-1).status,'cancelled');
});

test('bridge grant GET never resumes a revoked core grant and a failed read revokes sending',async t=>{
  const f=await fixture(t),input={enabled:true,automaticFaq:true,consent:true};
  await f.workbench.configureSelfTestReply(input);
  f.engine.setSelfTestReplyScope({available:true,enabled:false,automaticFaq:false});
  assert.equal((await f.workbench.getSelfTestReply()).enabled,false);
  await f.workbench.configureSelfTestReply(input);
  f.failRead();await assert.rejects(f.workbench.getSelfTestReply());
  assert.equal(f.engine.selfReply.enabled,false);
});
