import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,mkdirSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startManagedRuntime,loadManagedConfiguration } from '../src/managed-runtime.js';
import component from '../managed-component.json' with {type:'json'};

const boot={token:'synthetic-managed-token-'+ 'a'.repeat(32),releaseId:'b'.repeat(64)};
const freePort=async()=>{const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(done=>socket.close(done));return port;};
async function fixture(t,{expectedAgentId='synthetic-agent-a',...extras}={}){
  const base=mkdtempSync(resolve(tmpdir(),'bluesai-managed-runtime-'));
  const config={contract_version:1,component_id:'bluesai-cs-0001',expected_agent_id:expectedAgentId,data_dir:resolve(base,'data'),host:'127.0.0.1',port:await freePort(),initialize:true,...extras};
  const runtime=await startManagedRuntime(config,boot);
  t.after(async()=>{await runtime.shutdown();rmSync(base,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${config.port}`;
  const control=async(action,headers={})=>{
    const response=await fetch(url+'/api/managed/internal',{method:action?'POST':'GET',headers:{'X-Blueprint-Installer':boot.token,...(action?{'Content-Type':'application/json'}:{}),...headers},...(action?{body:JSON.stringify({action})}:{})});
    return {status:response.status,value:await response.json()};
  };
  return {runtime,config,base,url,control};
}

test('managed core starts paused and authenticates per-boot control without exposing secrets',async t=>{
  const f=await fixture(t);
  const status=await f.control();
  assert.equal(status.status,200);assert.equal(status.value.ready,true);assert.equal(status.value.paused,true);assert.equal(status.value.busy,false);assert.equal(status.value.data_schema,7);
  assert.equal(status.value.release_id,boot.releaseId);assert.equal(status.value.expected_agent_id,'synthetic-agent-a');
  assert.equal(status.value.node_version,process.version);assert.equal(status.value.stopping,false);
  assert.equal(JSON.stringify(status.value).includes(boot.token),false);
  assert.equal((await f.control(null,{'X-Blueprint-Installer':'old-token'})).status,404);
  assert.equal((await f.control(null,{Origin:f.url})).status,404);
  assert.equal((await fetch(f.url+'/healthz')).status,503);
  assert.equal((await f.control('resume')).value.paused,false);
  assert.equal((await fetch(f.url+'/healthz')).status,200);
  assert.equal((await f.control('quiesce')).value.paused,true);
  assert.equal((await fetch(f.url+'/webhooks/evolution',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
  assert.throws(()=>f.runtime.engine.receive({text:'must retry',eventId:'pending-callback'}),error=>error.status===503);
  assert.equal(f.runtime.store.get('SELECT COUNT(*) n FROM messages').n,0);
});

test('quiesce lets in-flight generation finish, retains version evidence, and never dispatches new queued work',async t=>{
  const f=await fixture(t);
  await f.control('resume');
  let finish;
  f.runtime.engine.agent={configured:true,provider:'synthetic-provider',model:'synthetic-model',reply:()=>new Promise(resolve=>{finish=resolve;})};
  f.runtime.store.set('settings',{mode:'auto',handoffContact:''});
  const fact='synthetic-approved-fact';
  f.runtime.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)',fact,'Synthetic','general','Verified response',1,null,Date.now());
  const incoming=f.runtime.engine.receive({text:'specific question',eventId:'synthetic-message'});
  const work=f.runtime.engine.tick();
  await delay(0);
  assert.equal(typeof finish,'function');
  const paused=await f.control('quiesce');
  assert.equal(paused.value.busy,true);
  assert.equal((await f.control('shutdown')).status,409);
  finish({text:'Verified response',decision:'answer',sourceIds:[fact],engine:'synthetic-provider'});
  await work;
  assert.equal((await f.control()).value.busy,false);
  const bound=f.runtime.store.get('SELECT snapshot_json,result_message_id FROM managed_job_versions WHERE job_id=?',incoming.messageId);
  assert.ok(bound.result_message_id);
  const snapshot=JSON.parse(bound.snapshot_json);
  assert.equal(snapshot.runtime.release_id,boot.releaseId);assert.equal(snapshot.runtime.version,component.version);
  assert.equal(snapshot.prompt.source_release_id,boot.releaseId);
  assert.equal(snapshot.model.model,'synthetic-model');assert.equal(snapshot.knowledge[0].id,fact);
  assert.ok(f.runtime.store.get("SELECT id FROM messages WHERE conversation_id=? AND status='queued'",incoming.conversationId));
  assert.equal(f.runtime.engine.bindRuntimeJob(incoming.messageId),true);
  f.runtime.engine.agent.model='changed-model';
  assert.equal(f.runtime.engine.bindRuntimeJob(incoming.messageId),false,'same executable must not silently substitute a known model');
  f.runtime.engine.agent.model='synthetic-model';
  f.runtime.store.run('UPDATE knowledge SET content=? WHERE id=?','Different confirmed content',fact);
  assert.equal(f.runtime.engine.bindRuntimeJob(incoming.messageId),false,'fact changes must be detected even without a revision bump');
});

test('quiesce tracks an awaited HTTP write even after its client disconnects',async t=>{
  const f=await fixture(t);await f.control('resume');
  const token=readFileSync(resolve(f.config.data_dir,'admin-token'),'utf8').trim();
  const login=await fetch(f.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  let finish,started;
  const running=new Promise(resolve=>{started=resolve;});
  f.runtime.engine.agent.learn=()=>{started();return new Promise(resolve=>{finish=resolve;});};
  const client=request(f.url+'/api/workbench/training',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.url,Cookie:cookie}});
  client.on('error',()=>{});client.end(JSON.stringify({text:'synthetic retained proposal'}));
  await running;client.destroy();await delay(20);
  assert.equal((await f.control('quiesce')).value.busy,true);
  finish({remember:false,text:'Synthetic review only'});
  for(let i=0;i<100&&(await f.control()).value.busy;i++)await delay(10);
  assert.equal((await f.control()).value.busy,false);
  assert.equal(f.runtime.store.get('SELECT COUNT(*) n FROM training_turns').n,2);
});

test('restart preserves data and uncertain sends without restoring native model or reply grants',async t=>{
  const base=mkdtempSync(resolve(tmpdir(),'bluesai-managed-restart-'));
  let first,second;
  t.after(async()=>{await second?.shutdown();await first?.shutdown();rmSync(base,{recursive:true,force:true});});
  const config={contract_version:1,component_id:'bluesai-cs-0001',expected_agent_id:'synthetic-stable-agent',data_dir:resolve(base,'data'),host:'127.0.0.1',port:await freePort(),initialize:true};
  first=await startManagedRuntime(config,boot);
  first.engine.resumeAfterUpdate();
  const item=first.engine.receive({text:'retained input',eventId:'once-event'});
  first.engine.bindRuntimeJob(item.messageId);
  first.store.run("UPDATE jobs SET state='running' WHERE id=?",item.messageId);
  const sending=first.store.addMessage(item.conversationId,'staff','synthetic send outcome',{status:'sending'});
  first.store.set('reply_provider',{provider:'codex-cli',model:'original-native-selection'});
  const credential=readFileSync(resolve(config.data_dir,'admin-token'));
  await Promise.all([first.shutdown(),first.shutdown()]);
  const database=resolve(config.data_dir,'service.sqlite');
  renameSync(database,database+'.synthetic-preserved');
  await assert.rejects(startManagedRuntime(config,boot),/MANAGED_DATABASE_MISSING/);
  assert.equal(existsSync(database),false,'an owned studio must never receive a replacement empty database');
  renameSync(database+'.synthetic-preserved',database);
  const admin=resolve(config.data_dir,'admin-token');
  renameSync(admin,admin+'.synthetic-preserved');
  await assert.rejects(startManagedRuntime(config,boot),/MANAGED_ADMIN_TOKEN_MISSING/);
  assert.equal(existsSync(admin),false,'an existing studio must never receive a replacement login token');
  renameSync(admin+'.synthetic-preserved',admin);
  second=await startManagedRuntime(config,{...boot,releaseId:'c'.repeat(64)});
  assert.deepEqual(readFileSync(resolve(config.data_dir,'admin-token')),credential);
  assert.equal(second.store.get('SELECT content FROM messages WHERE id=?',item.messageId).content,'retained input');
  assert.equal(second.store.get('SELECT status FROM messages WHERE id=?',sending).status,'uncertain');
  assert.equal(second.engine.agent.configured,false);
  assert.equal(second.engine.selfReply.enabled,false);
  assert.equal(second.status().paused,true);
  assert.equal(second.store.get('SELECT COUNT(*) n FROM events').n,1);
  second.engine.resumeAfterUpdate();
  await second.engine.processJob(second.store.get('SELECT * FROM jobs WHERE id=?',item.messageId));
  assert.equal(second.store.get('SELECT state FROM jobs WHERE id=?',item.messageId).state,'done');
  assert.equal(second.store.get("SELECT COUNT(*) n FROM audit WHERE action='managed_job_requires_review'").n,1);
  assert.equal(second.store.get('SELECT status FROM messages WHERE id=?',sending).status,'uncertain');
});

test('five private runtimes have distinct stable identities and no shared company records',async t=>{
  const instances=[];
  for(let i=0;i<5;i++)instances.push(await fixture(t,{expectedAgentId:'synthetic-agent-'+i}));
  const first=instances[0];await first.control('resume');
  first.runtime.engine.receive({text:'only studio zero',eventId:'studio-zero-event'});
  for(let i=1;i<instances.length;i++){
    assert.equal(instances[i].runtime.store.get('SELECT COUNT(*) n FROM messages').n,0);
    assert.equal(instances[i].runtime.status().expected_agent_id,'synthetic-agent-'+i);
    assert.equal(instances[i].runtime.status().paused,true);
  }
});

test('managed config rejects source paths, arbitrary commands, wrong identity and implicit data replacement',async t=>{
  const base=mkdtempSync(resolve(tmpdir(),'bluesai-managed-config-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const config={contract_version:1,component_id:'bluesai-cs-0001',expected_agent_id:'synthetic-config-agent',data_dir:resolve(base,'data'),host:'127.0.0.1',port:await freePort(),initialize:true};
  const file=resolve(base,'config.json');writeFileSync(file,JSON.stringify(config));assert.equal(loadManagedConfiguration(file).port,config.port);
  writeFileSync(file,JSON.stringify({...config,command:'unreviewed'}));assert.throws(()=>loadManagedConfiguration(file),/INVALID_MANAGED_CONFIGURATION/);
  writeFileSync(file,JSON.stringify({...config,data_dir:process.cwd()}));assert.throws(()=>loadManagedConfiguration(file),/OUTSIDE_SOURCE/);
  mkdirSync(config.data_dir);writeFileSync(resolve(config.data_dir,'keep.txt'),'private preexisting bytes');
  await assert.rejects(startManagedRuntime(config,boot),/MANAGED_DATA_NOT_EMPTY/);
  assert.equal(readFileSync(resolve(config.data_dir,'keep.txt'),'utf8'),'private preexisting bytes');
  assert.equal(existsSync(resolve(config.data_dir,'service.sqlite')),false);
});

test('CLI process exposes authenticated actual PID and exits gracefully only after quiescence',async t=>{
  const base=mkdtempSync(resolve(tmpdir(),'bluesai-managed-process-'));
  const config={contract_version:1,component_id:'bluesai-cs-0001',expected_agent_id:'synthetic-cli-agent',data_dir:resolve(base,'data'),host:'127.0.0.1',port:await freePort(),initialize:true};
  const file=resolve(base,'config.json');writeFileSync(file,JSON.stringify(config));
  const child=spawn(process.execPath,['src/managed-runtime.js','--config',file],{cwd:process.cwd(),env:{...process.env,BLUEPRINT_MODULE_TOKEN:boot.token,BLUEPRINT_MODULE_RELEASE_ID:boot.releaseId},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const url=`http://127.0.0.1:${config.port}/api/managed/internal`;
  const headers={'X-Blueprint-Installer':boot.token,'Content-Type':'application/json'};
  async function status(){try{const response=await fetch(url,{headers});return response.ok?await response.json():null;}catch{return null;}}
  t.after(async()=>{const value=await status();if(value){await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'quiesce'})});for(let i=0;i<100&&(await status())?.busy;i++)await delay(20);await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'shutdown'})}).catch(()=>{});}if(child.exitCode===null)await Promise.race([once(child,'exit'),delay(5000)]);assert.notEqual(child.exitCode,null,'owned synthetic runtime must stop');rmSync(base,{recursive:true,force:true});});
  let value;
  for(let i=0;i<600;i++){value=await status();if(value?.ready)break;if(child.exitCode!==null)throw Error('synthetic runtime failed: '+output);await delay(50);}
  assert.equal(value?.ready,true);assert.equal(value.pid,child.pid);assert.equal(value.paused,true);
  assert.equal(output.includes(boot.token),false);
  const exit=once(child,'exit');
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'shutdown'})});assert.equal(response.status,202);
  assert.equal((await response.json()).stopping,true);
  assert.deepEqual(await exit,[0,null]);
  assert.equal(existsSync(resolve(config.data_dir,'service.lock')),false);
});
