import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createConnections, createRuntimeAgent } from '../src/connections.js';
import { createApp } from '../src/server.js';
import { createAgent } from '../src/agent.js';

function fixture(t,{runtime=true,nativeAgentFactory,agent=createAgent(),fetchImpl}={}){
  const store=new Store(':memory:'),engine=new Engine(store,agent,{configured:false,deliveryEnabled:false});
  const connections=createConnections({store,engine,runtime,nativeAgentFactory,fetchImpl});
  t.after(async()=>{await engine.stop();store.close();});
  return {store,engine,connections};
}
function native({check=async()=>{},health=()=>({status:'connected',checkedAt:123,lastError:null})}={}){
  return {configured:true,provider:'codex-cli',model:'account_default',closed:0,check,health,
    async reply(){return {text:'請問需要了解哪項服務？',decision:'clarify',sourceIds:[],engine:'codex-cli'};},close(){this.closed++;}};
}

test('native Codex requires runtime availability and explicit consent without accepting caller-controlled executable or settings',async t=>{
  let created=0;
  const factory=()=>{created++;return native();};
  const preview=fixture(t,{runtime:false,nativeAgentFactory:factory});
  assert.equal(preview.connections.status().ai.nativeAvailable,false);
  await assert.rejects(preview.connections.nativeCodex({consent:true}),error=>error.status===409);
  const live=fixture(t,{nativeAgentFactory:factory});
  assert.equal(live.connections.status().ai.nativeAvailable,true);
  await assert.rejects(live.connections.nativeCodex({}),error=>error.status===400);
  await assert.rejects(live.connections.nativeCodex({consent:true,executable:'customer-controlled'}),error=>error.status===400);
  assert.equal(created,0);assert.equal(live.engine.agent.configured,false);
});

test('native activation waits for the actual probe, publishes sanitized health and never enables automatic policy flags',async t=>{
  let release;const candidate=native({check:()=>new Promise(resolve=>{release=resolve;})});
  const f=fixture(t,{nativeAgentFactory:()=>candidate});
  const activating=f.connections.nativeCodex({consent:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.connections.status().ai.status,'unconfigured');assert.equal(f.engine.agent.configured,false);
  release();await activating;
  assert.equal(f.engine.agent,candidate);
  assert.equal(f.connections.status().ai.status,'connected');assert.equal(f.connections.status().ai.provider,'codex-cli');
  assert.equal(f.connections.status().ai.checkedAt,123);
  assert.deepEqual(f.engine.inboxPolicy(),{enabled:false,automaticKnowledge:false,aiFallback:false,automaticAi:false});
  assert.equal(f.store.value('profile').name,'');
  candidate.health=()=>({status:'error',checkedAt:456,lastError:'CODEX_TIMEOUT',token:'hidden',stderr:'private-diagnostic'});
  assert.equal(f.connections.status().ai.lastError,'CODEX_TIMEOUT');assert.equal(f.connections.status().ai.status,'error');
  assert.doesNotMatch(JSON.stringify(f.connections.status()),/hidden|private-diagnostic/);
  candidate.health=()=>({status:'error',lastError:'secret text must not leak'});
  assert.equal(f.connections.status().ai.lastError,undefined);
});

test('failed native probe closes only the candidate and preserves the current provider, policy and private state',async t=>{
  const previous=native(),candidate=native({check:async()=>{throw new Error('private auth token and provider diagnostic');}});
  const f=fixture(t,{agent:previous,nativeAgentFactory:()=>candidate});
  f.engine.configureInbox({enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:false});
  const revision=f.store.value('revision');
  await assert.rejects(f.connections.nativeCodex({consent:true}),error=>error.status===502&&!/private|token|diagnostic/.test(error.message));
  assert.equal(f.engine.agent,previous);assert.equal(previous.closed,0);assert.equal(candidate.closed,1);
  assert.equal(f.store.value('revision'),revision);assert.equal(f.engine.inboxPolicy().aiFallback,true);
});

test('provider switching closes the old adapter and retires old generation instead of replaying it through the newly verified provider',async t=>{
  let late,signal;
  const previous=native();previous.reply=(input,options)=>{signal=options.signal;return new Promise(resolve=>{late=resolve;});};
  const candidate=native(),f=fixture(t,{agent:previous,nativeAgentFactory:()=>candidate});
  f.engine.configureInbox({enabled:true,automaticKnowledge:false,aiFallback:true,automaticAi:true});
  const r=f.engine.receive({text:'切換前的合成問題'}),running=f.engine.tick();
  await f.connections.nativeCodex({consent:true});await running;
  assert.equal(previous.closed,1);assert.equal(signal.aborted,true);assert.equal(f.engine.agent,candidate);
  assert.equal(f.engine.inboxPolicy().automaticAi,true);
  assert.equal(f.store.conversation(r.conversationId).state,'waiting');
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM jobs WHERE state='pending'").n,0);
  late({text:'舊 provider 的草稿',decision:'clarify',sourceIds:[],engine:'codex-cli'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.store.messages(r.conversationId).filter(m=>m.role==='assistant').length,0);
});

test('clearAI closes the native adapter, disables AI automation and preserves FAQ permissions and blank profile',async t=>{
  const candidate=native(),f=fixture(t,{nativeAgentFactory:()=>candidate});
  await f.connections.nativeCodex({consent:true});
  f.engine.configureInbox({enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
  await f.connections.clearAI();
  assert.equal(candidate.closed,1);assert.equal(f.engine.agent.configured,false);
  assert.equal(f.connections.status().ai.provider,'none');assert.equal(f.connections.status().ai.status,'unconfigured');
  assert.deepEqual(f.engine.inboxPolicy(),{enabled:true,automaticKnowledge:true,aiFallback:false,automaticAi:false});
  assert.equal(f.store.value('profile').name,'');
  assert.equal(f.store.value('reply_provider').provider,'none');
});

test('restart retains the native selection but requires a new probe and never silently selects ambient API credentials',async t=>{
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'bluesai-native-selection-')),path=join(dir,'fixture.sqlite');
  t.after(()=>{const actual=realpathSync(dir);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('bluesai-native-selection-'));rmSync(actual,{recursive:true});});
  const api={apiKey:'synthetic-api-credential',model:'synthetic-api-model'};
  let store=new Store(path);
  assert.equal(createRuntimeAgent(store,api).configured,true,'legacy environment selection remains compatible');
  let engine=new Engine(store,createAgent(),{}),connections=createConnections({engine,store,runtime:true,nativeAgentFactory:()=>native()});
  await connections.nativeCodex({consent:true});
  engine.configureInbox({enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
  await engine.stop();store.close();
  store=new Store(path);engine=new Engine(store,createRuntimeAgent(store,api),{});
  connections=createConnections({engine,store,runtime:true,nativeAgentFactory:()=>native(),aiConfig:api});
  try{
    assert.equal(engine.agent.configured,false);assert.equal(connections.status().ai.provider,'codex-cli');
    assert.equal(connections.status().ai.status,'configured');assert.equal(connections.status().ai.requiresCheck,true);
    const r=engine.receive({text:'重啟後的合成問題'});await engine.tick();
    assert.equal(store.conversation(r.conversationId).state,'waiting');assert.equal(store.get('SELECT COUNT(*) AS n FROM jobs').n,0);
    await assert.rejects(Promise.resolve().then(()=>engine.configureInbox({...engine.inboxPolicy()})),error=>error.status===409);
    await connections.nativeCodex({consent:true});assert.equal(connections.status().ai.requiresCheck,false);
    assert.equal(engine.inboxPolicy().automaticAi,true);assert.equal(store.get("SELECT COUNT(*) AS n FROM jobs WHERE state='pending'").n,0);
    await connections.clearAI();
  }finally{await engine.stop();store.close();}
  store=new Store(path);
  try{assert.equal(createRuntimeAgent(store,api).configured,false);assert.equal(store.value('profile').name,'');}finally{store.close();}
});

test('a durable provider-switch failure cannot replace the current adapter or falsely report a successful probe as active',async t=>{
  const previous=createAgent(),candidate=native(),f=fixture(t,{agent:previous,nativeAgentFactory:()=>candidate});
  const revise=f.store.revise.bind(f.store);f.store.revise=()=>{throw new Error('synthetic-durable-write-failure');};
  await assert.rejects(f.connections.nativeCodex({consent:true}),/synthetic-durable-write-failure/);
  f.store.revise=revise;
  assert.equal(f.engine.agent,previous);assert.equal(candidate.closed,1);assert.equal(f.connections.status().ai.status,'unconfigured');
});

test('native connection route requires the card login, same-origin consent and returns the real provider identity',async t=>{
  let created=0;const f=fixture(t,{nativeAgentFactory:()=>{created++;return native();}});
  const server=createApp({...f,adminToken:'fixture-admin-'.repeat(4),workbench:f.connections,runtimeMode:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,path='/api/agents/bluesai-cs-0001/connections/native-codex';
  const request=(headers,body={consent:true})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...headers},body:JSON.stringify(body)});
  assert.equal((await request({})).status,401);
  const login=await fetch(base+'/api/agents/bluesai-cs-0001/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({token:'fixture-admin-'.repeat(4)})});
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await request({...headers,Origin:'https://unrelated.invalid'})).status,403);
  assert.equal(created,0);
  const activated=await request(headers);assert.equal(activated.status,200);assert.equal((await activated.json()).provider,'codex-cli');
  const state=await(await fetch(base+'/api/agents/bluesai-cs-0001/state',{headers})).json();
  assert.equal(state.connections.ai.provider,'codex-cli');
  const legacy=await(await fetch(base+'/api/state',{headers})).json();assert.equal(legacy.runtime.agent,'codex-cli');
  assert.equal(created,1);assert.equal(f.engine.inboxPolicy().automaticAi,false);
});
