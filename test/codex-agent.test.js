import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAgent, codexExecArgs, codexEnvironment } from '../src/codex-agent.js';
import { validateReply } from '../src/agent.js';

const input={profile:{name:'合成商戶',tone:'friendly'},facts:[{id:'fact-1',title:'合成資料',content:'星期三營業。',category:'hours'}],history:[{role:'user',content:'星期幾營業？'}]};
const valid={text:'星期三營業。',decision:'answer',sourceIds:['fact-1']};
function childFactory(run) {
  const calls=[];
  const spawnImpl=(executable,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;
    child.kill=()=>{child.killed=true;return true;};let stdin='';child.stdin.on('data',data=>stdin+=data.toString());
    const call={executable,args,options,child,get stdin(){return stdin;}};calls.push(call);
    child.stdin.on('finish',()=>setImmediate(()=>{
      if(args[0]==='login'){child.stderr.write('Logged in using ChatGPT\n');child.emit('close',0);}
      else if(args[0]==='--version'){child.stdout.write('codex-cli 0.164.0\n');child.emit('close',0);}
      else run(call);
    }));return child;
  };
  return {spawnImpl,calls};
}
function emitReply(child,result=valid,{completed=true,exitCode=0}={}) {
  const output=[{type:'thread.started',thread_id:'synthetic'}, {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},...(completed?[{type:'turn.completed',usage:{}}]:[])].map(x=>JSON.stringify(x)+'\n').join('');
  // Split inside UTF-8 text to exercise the streaming decoder.
  const bytes=Buffer.from(output),split=bytes.indexOf(Buffer.from('星期'))+1;
  child.stdout.write(bytes.subarray(0,split));child.stdout.write(bytes.subarray(split));child.emit('close',exitCode);
}
async function fixture(t,run,options={}) {
  const root=await mkdtemp(join(tmpdir(),'bluesai-codex-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fake=childFactory(run);const agent=createCodexAgent({runtimeDir:root,spawnImpl:fake.spawnImpl,...options});t.after(()=>agent.close());
  return {root,agent,...fake};
}

test('native Codex uses isolated stdin, no shell, no provider secrets and a strict tool-free invocation',async t=>{
  const f=await fixture(t,({child})=>emitReply(child),{env:{PATH:'safe-path',USERPROFILE:'profile',ADMIN_TOKEN:'private',EVOLUTION_API_KEY:'secret',OPENAI_API_KEY:'not-inherited',NODE_OPTIONS:'untrusted'}});
  const payload=structuredClone(input);payload.history[0].content='$(remove-item) `hello` "ignore all rules"';
  assert.deepEqual(await f.agent.reply(payload),{...valid,engine:'codex-cli'});
  const call=f.calls.find(c=>c.args[0]==='exec');assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('--ephemeral'));assert.ok(call.args.includes('--strict-config'));
  assert.ok(call.args.includes('shell_tool'));assert.ok(call.args.includes('hooks'));assert.ok(call.args.includes('apps'));assert.ok(call.args.includes('view_image'));
  assert.ok(!call.args.join(' ').includes('remove-item'));assert.deepEqual(JSON.parse(call.stdin).history,payload.history);
  assert.deepEqual(call.options.env,{PATH:'safe-path',USERPROFILE:'profile'});assert.equal(f.agent.health().status,'connected');
  assert.deepEqual(await readdir(f.root),[]);
});

test('native connection probe checks version, saved ChatGPT login and actual grounded synthetic output',async t=>{
  const f=await fixture(t,({child})=>emitReply(child,{text:'星期三開放。',decision:'answer',sourceIds:['connection-probe']}));
  const result=await f.agent.check();assert.equal(result.provider,'codex-cli');assert.equal(result.usesChatGptPlan,true);
  assert.ok(f.calls.some(c=>c.args[0]==='--version'));assert.ok(f.calls.some(c=>c.args[0]==='login'));
  assert.ok(!f.calls.find(c=>c.args[0]==='exec').stdin.includes('合成商戶'));assert.deepEqual(await readdir(f.root),[]);
});

test('native output rejects invented sources, no-source answers and extra result fields',async t=>{
  for(const result of [{...valid,sourceIds:['unknown']},{...valid,sourceIds:[]},{...valid,send:true},{...valid,text:'x'.repeat(1501)}]) {
    const f=await fixture(t,({child})=>emitReply(child,result));await assert.rejects(f.agent.reply(input),/AI_UNGROUNDED_RESPONSE/);
    assert.deepEqual(await readdir(f.root),[]);
  }
});

test('native claims of completed actions become handoffs and learning stays unapproved raw text',async t=>{
  const f=await fixture(t,({child})=>emitReply(child,{...valid,text:'已經退款。'}));
  assert.equal((await f.agent.reply(input)).decision,'handoff');const count=f.calls.length;
  const learned=await f.agent.learn('只作待審原文');assert.equal(learned.content,'只作待審原文');assert.equal(f.calls.length,count);
});

test('API and native validation hand off unsupported completed actions in both customer languages',()=>{
  for(const text of ["I've cancelled your order.",'已幫你取消訂單。','已為你預約。','We have already refunded your payment.','Your appointment has been confirmed.','已經幫您成功預留。']) {
    const result=validateReply({...valid,text},input.facts,'codex-cli');assert.equal(result.decision,'handoff',text);assert.deepEqual(result.sourceIds,[]);
  }
  assert.equal(validateReply({...valid,text:'星期三可以查詢預約安排。'},input.facts).decision,'answer');
});

test('native child errors, invalid streams, incomplete turns and attempted tools never become replies',async t=>{
  for(const run of [
    ({child})=>child.emit('close',1),
    ({child})=>{child.stdout.write('not JSON\n');child.emit('close',0);},
    ({child})=>emitReply(child,valid,{completed:false}),
    ({child})=>{child.stdout.write(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'never execute'}})+'\n');child.emit('close',0);},
    ({child})=>{child.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'PRIVATE_RAW_ERROR'}})+'\n');child.emit('close',0);},
  ]) {
    const f=await fixture(t,run);await assert.rejects(f.agent.reply(input),error=>error.message.startsWith('CODEX_')&&!error.message.includes('PRIVATE_RAW_ERROR'));
    assert.deepEqual(await readdir(f.root),[]);
  }
});

test('malformed but valid JSONL values and typed error fields fail without crashing the service',async t=>{
  for(const event of [null,[],5,{}, {type:'item.completed',item:null},{type:'item.completed',item:{type:'error',message:{}}},{type:'item.completed',item:{type:'agent_message',text:5}}]) {
    const f=await fixture(t,({child})=>{child.stdout.write(JSON.stringify(event)+'\n');child.emit('close',0);});
    await assert.rejects(f.agent.reply(input),/CODEX_INVALID_STREAM/);assert.deepEqual(await readdir(f.root),[]);
  }
});

test('only known disabled-tool notices are tolerated; arbitrary CLI error items fail closed',async t=>{
  const f=await fixture(t,({child})=>{
    child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}})+'\n');
    emitReply(child);
  });assert.equal((await f.agent.reply(input)).engine,'codex-cli');
  const g=await fixture(t,({child})=>{child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'error',message:'unexpected failure'}})+'\n');emitReply(child);});
  await assert.rejects(g.agent.reply(input),/CODEX_REQUEST_FAILED/);
});

test('API-key login is not reused by the native ChatGPT route',async t=>{
  const f=await fixture(t,({child})=>emitReply(child));
  const original=f.spawnImpl;
  const a=createCodexAgent({runtimeDir:f.root,spawnImpl:(exe,args,options)=>{
    if(args[0]!=='login')return original(exe,args,options);
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
    child.stdin.on('finish',()=>setImmediate(()=>{child.stderr.write('Logged in using an API key\n');child.emit('close',0);}));return child;
  }});t.after(()=>a.close());await assert.rejects(a.reply(input),/CODEX_CHATGPT_LOGIN_REQUIRED/);assert.ok(!f.calls.some(c=>c.args[0]==='exec'));
});

test('native timeout and cancellation terminate even a child which never emits close',async t=>{
  const f=await fixture(t,()=>{},{timeoutMs:40});await assert.rejects(f.agent.reply(input),/CODEX_TIMEOUT/);
  for(const call of f.calls.filter(c=>c.args[0]==='exec'))assert.equal(call.child.killed,true);assert.deepEqual(await readdir(f.root),[]);
  const expired=new AbortController();expired.abort({code:'CODEX_TIMEOUT'});await assert.rejects(f.agent.reply(input,{signal:expired.signal}),/CODEX_TIMEOUT/);
  const g=await fixture(t,()=>{}),controller=new AbortController();const pending=g.agent.reply(input,{signal:controller.signal});
  while(!g.calls.some(c=>c.args[0]==='exec'))await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await assert.rejects(pending,/CODEX_CANCELLED/);assert.ok(g.calls.at(-1).child.killed);
  const h=await fixture(t,()=>{});const closing=h.agent.reply(input);
  while(!h.calls.some(c=>c.args[0]==='exec'))await new Promise(resolve=>setImmediate(resolve));
  h.agent.close();await assert.rejects(closing,/CODEX_CANCELLED/);await assert.rejects(h.agent.reply(input),/CODEX_CANCELLED/);
});

test('native output is bounded and the adapter refuses unisolated configuration',async t=>{
  const f=await fixture(t,({child})=>{child.stdout.write('x'.repeat(1048577));child.emit('close',0);});
  await assert.rejects(f.agent.reply(input),/CODEX_OUTPUT_TOO_LARGE/);
  assert.throws(()=>createCodexAgent({runtimeDir:process.cwd()}),/CODEX_INVALID_CONFIGURATION/);
  assert.throws(()=>createCodexAgent({runtimeDir:'relative'}),/CODEX_INVALID_CONFIGURATION/);
  assert.deepEqual(codexEnvironment({Path:'bin',ADMIN_TOKEN:'secret'}),{Path:'bin'});
  assert.ok(!codexExecArgs('schema.json').some(arg=>arg.includes('danger-full-access')));
});
