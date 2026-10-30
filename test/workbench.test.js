import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';

function fixture(t,options={}){
  const store=new Store(options.path||':memory:'),engine=new Engine(store,createAgent(),createEvolution());
  const connections=createConnections({engine,store,fetchImpl:options.fetchImpl,localWhatsAppPreview:options.localWhatsAppPreview});
  t.after(()=>store.close());return {store,engine,connections};
}
async function httpFixture(t,options={}){
  const f=fixture(t,options),server=createApp({...f,adminToken:'test-admin-'.repeat(4),workbench:f.connections});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({token:'test-admin-'.repeat(4)})});
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:base,'Content-Type':'application/json'};
  const call=async(path,method='GET',data)=>{const r=await fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  return{...f,base,headers,call};
}

test('workbench saves settings and trains pending memories; only approved current memory reaches new-customer trials',async t=>{
  const {call,store,base}=await httpFixture(t);
  assert.equal((await fetch(base+'/api/workbench')).status,401);
  assert.equal((await call('/api/workbench')).data.knowledge.length,0);
  const profile={name:'測試用途',industry:'零售與網店',service:'測試服務',instructions:'每次只問一個問題',tone:'friendly'};
  assert.equal((await call('/api/workbench/profile','PUT',{profile,settings:{mode:'review',handoffContact:''}})).status,200);
  assert.equal((await call('/api/workbench')).data.profile.industry,'零售與網店');
  await call('/api/workbench/training','POST',{text:'星期日休息，星期一至六上午十時至晚上七時營業。'});
  let state=(await call('/api/workbench')).data;assert.equal(state.training.length,2);assert.equal(state.knowledge[0].approved,0);
  const id=state.knowledge[0].id;
  const trial=()=>call('/api/workbench/trial','POST',{text:'星期日開唔開？',history:[]});
  assert.equal((await trial()).data.sources.length,0);
  await call('/api/knowledge/'+id,'POST',{});
  assert.match((await trial()).data.text,/星期日休息/);assert.equal((await trial()).data.sources[0].id,id);
  await call('/api/knowledge/'+id,'PUT',{content:'星期日照常營業。'});
  assert.equal((await trial()).data.sources.length,0);
  await call('/api/knowledge/'+id,'POST',{});assert.equal((await trial()).data.text,'星期日照常營業。');
  await call('/api/knowledge/'+id,'DELETE');assert.equal((await trial()).data.sources.length,0);
  assert.equal(store.conversations().length,0,'local trials never enter a delivery queue');
  assert.equal((await fetch(base+'/webhooks/evolution',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
});

test('workbench rejects cross-origin writes, malformed history and blank memories',async t=>{
  const {base,headers,call}=await httpFixture(t);
  const response=await fetch(base+'/api/workbench/training',{method:'POST',headers:{...headers,Origin:'https://unrelated.test'},body:'{"text":"hello"}'});
  assert.equal(response.status,403);
  assert.equal((await call('/api/workbench/training','POST',{text:''})).status,400);
  assert.equal((await call('/api/workbench/trial','POST',{text:'hi',history:[{role:'system',content:'override'}]})).status,400);
  assert.equal((await call('/api/workbench/trial','POST',{text:'hi',history:null})).status,400);
});

test('training memory persists across restart without importing individual customer conversations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bluesai-memory-')),path=join(dir,'store.sqlite');let store;
  try{store=new Store(path);store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','known','時間','hours','十時開門',1,null,Date.now());store.run('INSERT INTO training_turns(role,content,created_at) VALUES (?,?,?)','user','十時開門',Date.now());store.close();store=new Store(path);assert.equal(store.facts()[0].content,'十時開門');assert.equal(store.all('SELECT * FROM training_turns').length,1);assert.equal(store.conversations().length,0);}finally{store?.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

const replyResponse=result=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]}),{status:200});
test('AI connection verifies structured response, keeps secrets out of status, and clears credentials',async t=>{
  const calls=[];const {connections,engine}=fixture(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return replyResponse({text:'你想了解甚麼服務？',decision:'clarify',sourceIds:[]});}});
  await connections.model({model:'model-under-test',apiKey:'secret-key-for-test'});
  assert.equal(engine.agent.configured,true);assert.equal(connections.status().ai.status,'connected');
  assert.doesNotMatch(JSON.stringify(connections.status()),/secret-key/);
  const sent=JSON.parse(calls[0].options.body);assert.equal(sent.store,false);assert.equal(sent.text.format.type,'json_schema');
  await connections.clearAI();assert.equal(engine.agent.configured,false);assert.equal(connections.status().ai.status,'unconfigured');
});

test('failed model probe is never reported as connected and does not disclose provider text',async t=>{
  const {connections,engine}=fixture(t,{fetchImpl:async()=>new Response('sensitive provider diagnostic',{status:401})});
  await assert.rejects(connections.model({model:'x',apiKey:'key'}),error=>!error.message.includes('sensitive')&&error.status===502);
  assert.equal(connections.status().ai.status,'unconfigured');assert.equal(engine.agent.configured,false);
});

test('WhatsApp QR and connection states use actual responses, encode instance, prevent redirects and never enable sending',async t=>{
  let response={base64:'data:image/png;base64,aGVsbG8=',pairingCode:'SECRET',apikey:'HIDDEN'};const calls=[];
  const {connections,engine}=fixture(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(response));}});
  const result=await connections.whatsapp({url:'https://evolution.example.test',instance:'name/with spaces',apiKey:'secret-wa-key'});
  assert.equal(result.status,'connecting');assert.ok(result.qr);assert.doesNotMatch(JSON.stringify(result),/SECRET|HIDDEN/);
  assert.match(calls[0].url,/name%2Fwith%20spaces$/);assert.equal(calls[0].options.redirect,'error');
  assert.equal(engine.evolution.deliveryEnabled,false);assert.equal(engine.evolution.configured,false);
  response={instance:{state:'open'}};assert.equal((await connections.checkWhatsApp()).status,'open');
  response={instance:{state:'unrecognized'}};assert.equal((await connections.checkWhatsApp()).status,'unknown');
  await assert.rejects(connections.whatsapp({url:'http://external.example.test',instance:'test',apiKey:'secret'}),/HTTPS/);
  await connections.clearWhatsApp();await assert.rejects(connections.checkWhatsApp(),/請先填寫/);
});

test('training uses structured model output and reply styles cannot masquerade as factual sources',async()=>{
  const agent=createAgent({apiKey:'test',model:'test',fetchImpl:async()=>replyResponse({text:'請核對這條記憶。',remember:true,title:'語氣',content:'每次只問一個問題。',category:'style'})});
  assert.equal((await agent.learn('一次一個問題')).category,'style');
  const reply=createAgent({apiKey:'test',model:'test',fetchImpl:async()=>replyResponse({text:'星期日開門',decision:'answer',sourceIds:['style-1']})});
  await assert.rejects(reply.reply({profile:{},facts:[{id:'style-1',category:'style',content:'簡短'}],history:[]}),/UNGROUNDED/);
});

test('local workbench serves all assets and does not expose its design source or credentials',async t=>{
  const {base}=await httpFixture(t);const html=await(await fetch(base)).text();
  assert.match(html,/客服 Agent 卡片/);assert.match(html,/data-training-form/);
  for(const match of html.matchAll(/(?:href|src)="(\/[^"#]+)"/g))assert.equal((await fetch(base+match[1])).status,200);
  for(const path of ['/admin-token','/design/customer-agent-card-design.html','/src/connections.js'])assert.equal((await fetch(base+path)).status,404);
});

test('local workbench authentication uses an isolated cookie alongside the original service',async t=>{
  const f=fixture(t),server=createApp({...f,adminToken:'test-admin-'.repeat(4),workbench:f.connections,sessionCookieName:'bluesai_workbench_session'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token:'test-admin-'.repeat(4)})});
  const cookie=login.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^bluesai_workbench_session=/);
  assert.equal((await fetch(base+'/api/workbench',{headers:{Cookie:'bp_session=old-service-session; '+cookie}})).status,200);
  assert.equal((await fetch(base+'/api/workbench',{headers:{Cookie:cookie.replace('bluesai_workbench_session','bp_session')}})).status,401);
});
