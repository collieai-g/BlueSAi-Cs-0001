import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgent,validateReply,conversationLearningInput,validateConversationLearning,learningInput,validateLearning,replySchema} from '../src/agent.js';
import {createCodexAgent,codexExecArgs} from '../src/codex-agent.js';

const transcript={messages:[{id:'customer-1',role:'user',content:'貨品幾時到？'},{id:'staff-1',role:'staff',content:'請問你查詢邊款貨品？'},{id:'assistant-1',role:'assistant',content:'沒有依據的舊AI內容。'}],knowledge:[]};
const proposal={kind:'procedure',title:'先識別客戶查詢的貨品',content:'收到到貨查詢而仍未知道貨品時，先詢問貨品；已說明貨品時沿用已知資料。實際出貨安排仍待商戶補充。',category:'procedure',rationale:'人工先釐清貨品，尚未承諾到貨日期。',evidenceMessageIds:['staff-1'],questions:['確定貨品後應再確認甚麼資料？']};
const output={proposals:[proposal]};
const apiResponse=value=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]}));

function fakeCli(respond){
 const calls=[];
 const spawnImpl=(exe,args,options)=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;return true;};let stdin='';child.stdin.on('data',chunk=>stdin+=chunk.toString());
  const call={exe,args,options,child,get stdin(){return stdin;}};calls.push(call);
  child.stdin.on('finish',()=>setImmediate(()=>{
   if(args[0]==='login'){child.stderr.write('Logged in using ChatGPT\n');child.emit('close',0);}
   else respond(call);
  }));return child;
 };return {calls,spawnImpl};
}
function emit(child,result){child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})+'\n'+JSON.stringify({type:'turn.completed'})+'\n');child.emit('close',0);}
async function nativeFixture(t,respond,options={}){const root=await mkdtemp(join(tmpdir(),'bluesai-learning-model-')),fake=fakeCli(respond),agent=createCodexAgent({runtimeDir:root,spawnImpl:fake.spawnImpl,...options});t.after(async()=>{agent.close();await rm(root,{recursive:true,force:true});});return {root,agent,...fake};}

test('a procedure guides a clarification but never proves a business answer',()=>{
 const facts=[{id:'procedure-1',category:'procedure',content:'先識別貨品。'},{id:'style-1',category:'style',content:'簡明。'},{id:'fact-1',category:'general',content:'提供工作室功能。'}];
 const clarify={text:'請問你查詢邊款貨品？',decision:'clarify',sourceIds:[],procedureIds:['procedure-1']};
 assert.deepEqual(validateReply(clarify,facts),{...clarify,engine:'openai'});
 for(const result of [{...clarify,decision:'answer'},{...clarify,sourceIds:['procedure-1']},{...clarify,sourceIds:['style-1']},{...clarify,procedureIds:['fact-1']},{...clarify,procedureIds:['missing']}])assert.throws(()=>validateReply(result,facts),/AI_UNGROUNDED_RESPONSE/);
 const legacy={text:'提供工作室功能。',decision:'answer',sourceIds:['fact-1']};assert.deepEqual(validateReply(legacy,facts),{...legacy,engine:'openai'});
 assert.ok(replySchema.required.includes('procedureIds'));
});

test('API semantic replies separate approved facts, procedures and style while preserving prior customer details',async()=>{
 let sent;
 const agent=createAgent({apiKey:'synthetic-key',model:'synthetic-model',fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return apiResponse({text:'可以在工作室建立客服卡片。',decision:'answer',sourceIds:['function-1'],procedureIds:[]});}});
 const result=await agent.reply({profile:{name:'合成工作室'},facts:[{id:'function-1',title:'如何建立客服？',content:'可以在工作室建立客服卡片。',category:'general'},{id:'procedure-1',content:'先確認客戶所指功能。',category:'procedure'},{id:'style-1',content:'簡短。',category:'style'}],history:[{role:'user',content:'我已經開咗工作室。'},{role:'user',content:'想整個幫手答客嘅助手，點開始？'}]});
 assert.equal(result.decision,'answer');const payload=JSON.parse(sent.input[0].content);
 assert.deepEqual(payload.facts.map(f=>f.id),['function-1']);assert.deepEqual(payload.procedures.map(f=>f.id),['procedure-1']);assert.equal(payload.conversation.length,2);
 assert.match(sent.instructions,/不同問法/);assert.match(sent.instructions,/不重問已知/);assert.equal(sent.store,false);
});

test('conversation analysis preserves human provenance, redacts identifiers and returns unapproved proposals',async()=>{
 let request;
 const agent=createAgent({apiKey:'synthetic-key',model:'synthetic-model',fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return apiResponse(output);}});
 const input=structuredClone(transcript);input.messages[0].phone='synthetic-private-field';input.messages[0].content+=' 電話：+852 5555 0123\n請寄 test@example.test。';
 const result=await agent.analyzeConversation(input);
 assert.deepEqual(result,output);const payload=JSON.parse(request.input[0].content);
 assert.deepEqual(payload.messages.map(m=>m.role),['user','staff','assistant']);assert.ok(!JSON.stringify(payload).includes('synthetic-private-field'));assert.doesNotMatch(JSON.stringify(payload),/5555|test@example/);
 assert.equal(request.text.format.name,'conversation_learning');assert.equal(request.store,false);assert.match(request.instructions,/待確認/);
 assert.equal(result.proposals[0].approved,undefined);
});

test('analysis rejects customer or AI evidence, invented sources, category mismatches, personal data and oversized output',()=>{
 const input=conversationLearningInput(transcript);
 for(const patch of [{evidenceMessageIds:['customer-1']},{evidenceMessageIds:['assistant-1']},{evidenceMessageIds:['invented']},{evidenceMessageIds:[]},{kind:'fact'},{category:'general'},{content:'請聯絡 test@example.test。'},{rationale:'電話是85255550123。'},{questions:['x'.repeat(201)]},{title:'x'.repeat(101)},{content:'x'.repeat(2001)},{send:true}])assert.throws(()=>validateConversationLearning({proposals:[{...proposal,...patch}]},input),/MODEL_INVALID_PROPOSALS/);
 assert.throws(()=>validateConversationLearning({proposals:Array(4).fill(proposal)},input),/MODEL_INVALID_PROPOSALS/);
 assert.deepEqual(validateConversationLearning({proposals:[]},input),{proposals:[]});
 assert.throws(()=>conversationLearningInput({messages:transcript.messages.filter(m=>m.role!=='staff'),knowledge:[]}),/MANUAL_EVIDENCE_REQUIRED/);
});

test('model learning snapshots are bounded and exclude unapproved or expired knowledge',()=>{
 const input=conversationLearningInput({messages:Array.from({length:100},(_,i)=>({id:'staff-'+i,role:'staff',content:'合成內容'.repeat(2000)})),knowledge:[{id:'pending',content:'待確認',approved:false},{id:'expired',content:'過期',expires_at:1},...Array.from({length:100},(_,i)=>({id:'fact-'+i,content:'資料'.repeat(4000)}))]});
 assert.ok(input.messages.length<=24);assert.ok(input.messages.every(m=>m.content.length<=2000));assert.ok(Buffer.byteLength(JSON.stringify(input.messages))<25000);assert.ok(Buffer.byteLength(JSON.stringify(input.knowledge))<25000);assert.ok(!input.knowledge.some(f=>['pending','expired'].includes(f.id)));
 assert.throws(()=>learningInput('x'.repeat(2001)),/INVALID_INPUT/);
 assert.throws(()=>validateLearning({text:'待確認',remember:true,title:'流程',content:'電話85255550123',category:'procedure'}),/TRAINING_INVALID/);
});

test('an offline adapter cannot report raw text classification as AI conversation analysis',async()=>{
 const agent=createAgent();await assert.rejects(agent.analyzeConversation(transcript),/MODEL_UNAVAILABLE/);
 const result=await agent.learn('客人問到貨先問貨品。');assert.equal(result.category,'procedure');assert.match(result.text,/原文/);
});

test('native conversation learning uses strict isolated inference and only supports staff evidence',async t=>{
 const f=await nativeFixture(t,call=>emit(call.child,output));assert.deepEqual(await f.agent.analyzeConversation(transcript),output);
 const call=f.calls.find(c=>c.args[0]==='exec');assert.equal(call.options.shell,false);assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.some(arg=>arg.endsWith('analyze-schema.json')));assert.equal(JSON.parse(call.stdin).messages[1].role,'staff');assert.deepEqual(await readdir(f.root),[]);
 assert.throws(()=>codexExecArgs('synthetic-schema.json','arbitrary-user-task'),/CODEX_INVALID_CONFIGURATION/);
 const invalid=await nativeFixture(t,call=>emit(call.child,{proposals:[{...proposal,evidenceMessageIds:['customer-1']}]}));await assert.rejects(invalid.agent.analyzeConversation(transcript),/MODEL_INVALID_PROPOSALS/);assert.deepEqual(await readdir(invalid.root),[]);
});

test('native analysis and teaching share cancellation and cleanup without an API fallback',async t=>{
 for(const operation of ['analyzeConversation','learn']){
  const f=await nativeFixture(t,()=>{}),controller=new AbortController();
  const pending=operation==='learn'?f.agent.learn('先確認貨品再處理查詢。',[],{signal:controller.signal}):f.agent.analyzeConversation(transcript,{signal:controller.signal});
  while(!f.calls.some(c=>c.args[0]==='exec'))await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await assert.rejects(pending,/CODEX_CANCELLED/);assert.equal(f.calls.at(-1).child.killed,true);assert.deepEqual(await readdir(f.root),[]);
 }
});

test('native teaching and analysis have independent bounded budgets without extending customer replies',async t=>{
 const learned={text:'請核對流程。',remember:true,title:'識別貨品',content:'資料不足時先確認貨品。',category:'procedure'};
 const f=await nativeFixture(t,call=>{
  if(call.args.some(arg=>arg.endsWith('reply-schema.json')))return;
  setTimeout(()=>emit(call.child,call.args.some(arg=>arg.endsWith('learn-schema.json'))?learned:output),80);
 },{timeoutMs:40,learningTimeoutMs:300});
 assert.deepEqual(await f.agent.learn('到貨查詢先識別貨品。'),learned);
 await assert.rejects(f.agent.reply({profile:{},facts:[],history:[{role:'user',content:'合成即時查詢。'}]}),/CODEX_TIMEOUT/);
 assert.deepEqual(await f.agent.analyzeConversation(transcript),output);assert.deepEqual(await readdir(f.root),[]);
 assert.throws(()=>createCodexAgent({runtimeDir:f.root,timeoutMs:25001}),/CODEX_INVALID_CONFIGURATION/);
 for(const value of [0,60001,1.5])assert.throws(()=>createCodexAgent({runtimeDir:f.root,learningTimeoutMs:value}),/CODEX_INVALID_CONFIGURATION/);
 const fullBudget=createCodexAgent({runtimeDir:f.root,learningTimeoutMs:60000,spawnImpl:f.spawnImpl});fullBudget.close();
});

test('a native background-learning deadline still fails and its sixty-second budget respects caller cancellation',async t=>{
 const timed=await nativeFixture(t,()=>{},{timeoutMs:200,learningTimeoutMs:40});
 await assert.rejects(timed.agent.analyzeConversation(transcript),/CODEX_TIMEOUT/);assert.equal(timed.agent.health().lastError,'CODEX_TIMEOUT');
 const f=await nativeFixture(t,()=>{},{learningTimeoutMs:60000}),controller=new AbortController();
 const pending=f.agent.learn('先確認貨品再回答。',[],{signal:controller.signal});
 while(!f.calls.some(call=>call.args[0]==='exec'))await new Promise(resolve=>setImmediate(resolve));
 controller.abort('owner_stopped_learning');await assert.rejects(pending,/CODEX_CANCELLED/);assert.equal(f.calls.at(-1).child.killed,true);assert.deepEqual(await readdir(f.root),[]);
});

test('API learning uses sixty seconds while ordinary replies retain their existing request budget',async t=>{
 const budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 const agent=createAgent({apiKey:'synthetic-key',model:'synthetic-model',fetchImpl:async(url,options)=>{
  const name=JSON.parse(options.body).text.format.name;
  return apiResponse(name==='training_memory'?{text:'請核對流程。',remember:true,title:'貨品識別',content:'先確認貨品。',category:'procedure'}:name==='conversation_learning'?output:{text:'合成事實。',decision:'answer',sourceIds:['fact'],procedureIds:[]});
 }});
 await agent.learn('先識別貨品。');await agent.analyzeConversation(transcript);await agent.reply({profile:{},facts:[{id:'fact',category:'general',content:'合成事實。'}],history:[]});
 assert.deepEqual(budgets,[60000,60000,30000]);
});

test('API background learning forwards caller cancellation without waiting for its full deadline',async()=>{
 let requestSignal;
 const agent=createAgent({apiKey:'synthetic-key',model:'synthetic-model',fetchImpl:async(url,options)=>new Promise((resolve,reject)=>{requestSignal=options.signal;requestSignal.addEventListener('abort',()=>reject(new Error('synthetic request aborted')),{once:true});})});
 const controller=new AbortController(),pending=agent.analyzeConversation(transcript,{signal:controller.signal});
 while(!requestSignal)await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,/synthetic request aborted/);assert.equal(requestSignal.aborted,true);
});
