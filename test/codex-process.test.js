import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexAgent } from '../src/codex-agent.js';

const helper = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  child.once('spawn',()=>process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'synthetic-process-cancellation',parentPid:process.pid,childPid:child.pid})+'\\n'));
  child.once('error',()=>process.exit(2));
  setInterval(()=>{},1000);
`;

function loginStub() {
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>true;
  child.stdin.once('finish',()=>setImmediate(()=>{child.stderr.write('Logged in using ChatGPT\n');child.emit('close',0);}));
  return child;
}

async function alive(pid) {
  try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return false;throw error;}
  // Linux can retain a killed orphan as a zombie until PID 1 reaps it. It has
  // already terminated and cannot execute; waiting for its PID to disappear
  // would test the CI container's init rather than this adapter's process group.
  if(process.platform==='linux'){
    try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');if(/^\s*[ZX]\s/.test(stat.slice(stat.lastIndexOf(')')+1)))return false;}
    catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return false;throw error;}
  }
  return true;
}

async function until(predicate,timeoutMs,message) {
  const end=Date.now()+timeoutMs;
  while(!(await predicate())){if(Date.now()>=end)throw new Error(message);await delay(20);}
}

test('native cancellation terminates an actual synthetic Node process tree and removes its workspace', {timeout:9500}, async t=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'bluesai-process-test-'));
  let spawnedParent,childPid,agent,observed='',record;
  const controller=new AbortController();
  const ownedPids=new Set();
  t.after(async()=>{
    controller.abort();agent?.close();
    // Only exact PIDs obtained from our spawn and its fixed helper's child.spawn
    // record can reach cleanup. There is no process-name or directory matching.
    for(const pid of [...ownedPids].reverse()){
      if(await alive(pid)){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    }
    await until(async()=>!(await Promise.all([...ownedPids].map(alive))).some(Boolean),1500,'Owned synthetic process did not terminate during cleanup');
    const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('bluesai-process-test-'));
    await rm(actual,{recursive:true,maxRetries:4,retryDelay:50});
  });
  agent=createCodexAgent({runtimeDir:root,timeoutMs:4000,spawnImpl:(executable,args,options)=>{
    if(args[0]==='login')return loginStub();
    assert.equal(args[0],'exec','Only the synthetic exec branch may launch a real process');
    assert.equal(options.shell,false);assert.equal(spawnedParent,undefined,'The test launches one owned process tree');
    spawnedParent=spawn(process.execPath,['-e',helper],options);
    assert.ok(Number.isInteger(spawnedParent.pid)&&spawnedParent.pid>0);ownedPids.add(spawnedParent.pid);
    spawnedParent.stdout.on('data',chunk=>{
      observed+=chunk.toString('utf8');
      const end=observed.indexOf('\n');
      if(end<0||record)return;
      record=JSON.parse(observed.slice(0,end));
      assert.equal(record.parentPid,spawnedParent.pid);assert.equal(record.thread_id,'synthetic-process-cancellation');
      childPid=record.childPid;assert.ok(Number.isInteger(childPid)&&childPid>0&&childPid!==spawnedParent.pid);
      ownedPids.add(childPid);
    });
    return spawnedParent;
  }});
  // Retain the outcome immediately, so a startup failure is observed rather
  // than becoming an unhandled rejection while waiting for the PID record.
  const outcome=agent.reply({profile:{},facts:[],history:[{role:'user',content:'合成程序取消測試；不需要模型。'}]}, {signal:controller.signal})
    .then(value=>({value}),error=>({error}));
  await until(()=>Boolean(record),3000,'Synthetic helper did not report its parent/child PIDs');
  assert.equal(await alive(spawnedParent.pid),true);assert.equal(await alive(childPid),true);
  controller.abort();
  let timer;
  const result=await Promise.race([outcome,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Adapter did not settle after process-tree cancellation')),2000);})]).finally(()=>clearTimeout(timer));
  assert.match(result.error?.message||'',/CODEX_CANCELLED/);
  await until(async()=>!(await alive(spawnedParent.pid))&&!(await alive(childPid)),2000,'Adapter cancellation left an owned parent or child running');
  assert.deepEqual(await readdir(root),[],'The native workspace is removable after cancellation');
});

test('a completed synthetic Node turn cannot leave its still-running exec host behind', {timeout:6500}, async t=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'bluesai-completed-host-'));
  let execution,agent;
  t.after(async()=>{
    agent?.close();
    if(execution?.pid&&await alive(execution.pid)){try{process.kill(execution.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    if(execution?.pid)await until(async()=>!(await alive(execution.pid)),1500,'Owned synthetic exec survived cleanup');
    const actual=await realpath(root);assert.equal(dirname(actual),parent);assert.ok(basename(actual).startsWith('bluesai-completed-host-'));await rm(actual,{recursive:true,maxRetries:4,retryDelay:50});
  });
  const script=`process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'Synthetic verified answer.',decision:'answer',sourceIds:['synthetic-fact']})}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');setInterval(()=>{},1000);`;
  agent=createCodexAgent({runtimeDir:root,timeoutMs:4000,spawnImpl:(executable,args,options)=>{
    if(args[0]==='login')return loginStub();
    assert.equal(args[0],'exec');assert.equal(options.shell,false);assert.equal(execution,undefined);
    execution=spawn(process.execPath,['-e',script],options);assert.ok(Number.isInteger(execution.pid)&&execution.pid>0);return execution;
  }});
  const result=await agent.reply({profile:{},facts:[{id:'synthetic-fact',content:'Synthetic verified answer.',category:'general'}],history:[{role:'user',content:'Synthetic public fixture only.'}]});
  assert.equal(result.decision,'answer');await until(async()=>!(await alive(execution.pid)),1000,'Completed owned exec did not terminate');assert.deepEqual(await readdir(root),[]);
});
