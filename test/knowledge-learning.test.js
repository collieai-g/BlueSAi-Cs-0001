import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createKnowledgeLearning, redactLearningText } from '../src/knowledge-learning.js';

const proposal=(messages,extra={})=>({kind:'procedure',title:'到貨查詢處理方法',content:'客戶詢問到貨安排而未說明貨品時，先問清楚貨品；未有資料前不可承諾到貨日。',category:'procedure',
  rationale:'人工先釐清查詢對象，沒有直接承諾日期。',evidenceMessageIds:[messages.filter(m=>m.role==='staff').at(-1).id],questions:[],...extra});
function fixture(t,{model,configured=true,analysisTimeoutMs=200}={}){
  const store=new Store(':memory:'),calls=[];
  const engine={agent:{configured,provider:'synthetic-model',async analyzeConversation(input,options){calls.push({input,options});return model?model(input,options):{proposals:[proposal(input.messages)]};}}};
  const service=createKnowledgeLearning({store,engine,analysisTimeoutMs,intervalMs:20});
  t.after(()=>{service.stop();if(!store.closed)store.close();});
  let sequence=0;
  function conversation(channel='evolution'){
    const id='synthetic-conversation-'+(++sequence);
    store.run('INSERT INTO conversations(id,channel,address,name,state,updated_at) VALUES (?,?,?,?,?,?)',id,channel,'synthetic-address-'+sequence,'合成測試','human',Date.now());return id;
  }
  function exchange({channel='evolution',status='accepted',role='staff',question='我的貨品幾時到？',answer='請問你查詢哪一件貨品？'}={}){
    const id=conversation(channel),userId=store.addMessage(id,'user',question),staffId=store.addMessage(id,role,answer,{status});return {id,userId,staffId};
  }
  return {store,engine,service,calls,conversation,exchange};
}
async function until(check,timeout=1500){const end=Date.now()+timeout;while(!check()){if(Date.now()>=end)throw Error('Synthetic learning condition did not settle');await delay(5);}}
async function prepare(f){const source=f.exchange(),collected=f.service.collect();return {...source,caseId:collected.caseIds[0]};}
async function analyzed(f){const c=await prepare(f);const queued=f.service.analyze(c.caseId);assert.equal(queued.status,'queued');await until(()=>f.service.status().cases.find(x=>x.id===c.caseId).status==='analyzed');return {...c,proposal:f.service.status().proposals[0]};}

test('managed pause drains active learning without aborting it and holds the next queued case until resume',async t=>{
  const releases=[];
  const f=fixture(t,{analysisTimeoutMs:2000,model:input=>new Promise(resolve=>{
    releases.push(()=>resolve({proposals:[proposal(input.messages)]}));
  })});
  const first=await prepare(f),second=await prepare(f);
  f.service.analyze(first.caseId);f.service.analyze(second.caseId);
  await until(()=>releases.length===1);
  f.service.pauseForUpdate();assert.equal(f.service.updateBusy(),true);assert.equal(f.calls[0].options.signal.aborted,false);
  releases[0]();await until(()=>!f.service.updateBusy());await delay(20);
  assert.equal(f.calls.length,1);assert.equal(f.service.status().cases.find(x=>x.id===first.caseId).status,'analyzed');
  f.service.resumeAfterUpdate();await until(()=>releases.length===2);
  releases[1]();await until(()=>!f.service.updateBusy());
  assert.equal(f.service.status().cases.find(x=>x.id===second.caseId).status,'analyzed');
});

test('collect uses only genuinely submitted human replies, preserves roles and never changes active knowledge or revision',t=>{
  const f=fixture(t),revision=f.store.value('revision');
  f.exchange();f.exchange({channel:'web',status:'read'});
  for(const channel of ['demo','whatsapp_self_test'])f.exchange({channel});
  for(const status of ['queued','sending','draft','uncertain','failed','simulated'])f.exchange({status});
  f.exchange({role:'assistant'});
  const result=f.service.collect();assert.equal(result.collected,2);assert.equal(f.service.collect().collected,0);
  assert.equal(f.service.status().settings.automaticAnalysis,false);assert.equal(f.calls.length,0);
  assert.equal(f.store.value('revision'),revision);assert.equal(f.store.get('SELECT COUNT(*) n FROM knowledge').n,0);
  assert.deepEqual(f.service.status().cases.map(c=>c.sourceCount),[2,2]);
});

test('capture redacts common personal identifiers in its bounded snapshot without changing the original conversation',t=>{
  const f=fixture(t),raw='電話 +852 5555 0123，電郵 person@example.test，訂單編號 ABCD1234，地址：合成地址。';
  const source=f.exchange({question:raw});f.service.collect();
  const snapshot=JSON.parse(f.store.get('SELECT snapshot_json FROM learning_cases').snapshot_json);
  assert.doesNotMatch(JSON.stringify(snapshot),/5555|person@|ABCD1234|合成地址/);
  assert.match(snapshot.messages[0].content,/已移除/);
  assert.equal(f.store.get('SELECT content FROM messages WHERE id=?',source.userId).content,raw);
  assert.deepEqual(snapshot.messages.map(m=>m.role),['user','staff']);
  assert.doesNotMatch(redactLearningText('Bearer synthetic-secret-token-123456 https://example.test/private'),/synthetic-secret-token-123456/);
});

test('analysis is independently queued, keeps proposals pending, and never teaches the active knowledge by itself',async t=>{
  const f=fixture(t),source=await prepare(f),revision=f.store.value('revision');
  const queued=f.service.analyze(source.caseId);assert.equal(queued.status,'queued');assert.equal(f.calls.length,0);
  await until(()=>f.service.status().cases[0].status==='analyzed');
  const status=f.service.status();assert.equal(f.calls.length,1);assert.equal(status.proposals[0].status,'pending');
  assert.equal(status.proposals[0].kind,'procedure');assert.equal(status.proposals[0].evidence[0].role,'staff');
  assert.equal(f.store.get('SELECT COUNT(*) n FROM knowledge').n,0);assert.equal(f.store.value('revision'),revision);
  assert.equal(f.service.analyze(source.caseId).duplicate,true);assert.equal(f.calls.length,1);
});

test('automatic analysis defaults off, waits for a model, and never changes reply policy when opted in',async t=>{
  const f=fixture(t,{configured:false}),source=f.exchange(),policy=f.store.value('inbox_policy'),revision=f.store.value('revision');
  f.service.start();await delay(35);assert.equal(f.service.status().counts.pendingCases,1);assert.equal(f.calls.length,0);
  f.service.configure({automaticAnalysis:true,consent:true});await delay(35);assert.equal(f.calls.length,0);assert.equal(f.service.status().model.ready,false);
  assert.deepEqual(f.store.value('inbox_policy'),policy);assert.equal(f.store.value('revision'),revision);
  f.engine.agent.configured=true;await until(()=>f.service.status().counts.pendingProposals===1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.messages.at(-1).id,source.staffId);
});

test('model snapshots preserve AI versus human roles and only human evidence may support a proposal',async t=>{
  const f=fixture(t,{model:input=>({proposals:[proposal(input.messages,{evidenceMessageIds:[input.messages.find(m=>m.role==='assistant').id]})]})});
  const id=f.conversation();f.store.addMessage(id,'user','合成問題');f.store.addMessage(id,'assistant','先前 AI 答覆',{status:'accepted'});f.store.addMessage(id,'staff','人工先查明條件',{status:'accepted'});
  const c=f.service.collect().caseIds[0];f.service.analyze(c);await until(()=>f.service.status().cases[0].status==='failed');
  assert.deepEqual(f.calls[0].input.messages.map(m=>m.role),['user','assistant','staff']);
  assert.equal(f.service.status().cases[0].lastError,'LEARNING_INVALID_RESPONSE');assert.equal(f.service.status().proposals.length,0);
});

test('approval requires owner confirmation, creates an edited approved procedure once and advances revision only then',async t=>{
  const f=fixture(t),r=await analyzed(f),revision=f.store.value('revision');
  assert.throws(()=>f.service.approve(r.proposal.id,{}),error=>error.status===400);
  const accepted=f.service.approve(r.proposal.id,{confirmed:true,title:'確認查詢貨品',content:'未說明貨品時先釐清貨品；沒有查單資料便交人工。',category:'procedure'});
  const knowledge=f.store.get('SELECT * FROM knowledge WHERE id=?',accepted.knowledgeId);
  assert.equal(knowledge.approved,1);assert.equal(knowledge.category,'procedure');assert.match(knowledge.content,/交人工/);
  assert.equal(f.store.value('revision'),revision+1);assert.equal(f.service.approve(r.proposal.id,{confirmed:true}).duplicate,true);
  assert.equal(f.store.value('revision'),revision+1);assert.equal(f.store.get('SELECT COUNT(*) n FROM faq_rules').n,0);
});

test('unresolved questions and same-title conflicts require explicit review, without overwriting the existing fact',async t=>{
  const f=fixture(t,{model:input=>({proposals:[proposal(input.messages,{kind:'fact',category:'hours',title:'合成營業時間',content:'星期二開放。',questions:['適用於哪個門市？']})]})});
  f.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','existing','合成營業時間','hours','星期一開放。',1,null,Date.now());
  const r=await analyzed(f);assert.equal(r.proposal.conflicts.length,1);assert.equal(r.proposal.questions.length,1);
  assert.throws(()=>f.service.approve(r.proposal.id,{confirmed:true}),error=>error.status===409);
  const result=f.service.approve(r.proposal.id,{confirmed:true,reviewed:true});assert.ok(result.knowledgeId);
  assert.equal(f.store.get('SELECT content FROM knowledge WHERE id=?','existing').content,'星期一開放。');
});

test('source edits during analysis discard the result, and source edits after analysis block approval',async t=>{
  let release;const f=fixture(t,{model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})});
  const c=await prepare(f);f.service.analyze(c.caseId);await until(()=>Boolean(release));
  f.store.run('UPDATE messages SET content=? WHERE id=?','人工更正後的內容',c.staffId);release();
  await until(()=>f.service.status().cases[0].status==='failed');assert.equal(f.service.status().cases[0].lastError,'LEARNING_SOURCE_STALE');assert.equal(f.service.status().proposals.length,0);
  const g=fixture(t),p=await analyzed(g);g.store.run('UPDATE messages SET content=? WHERE id=?','後來更正',p.staffId);
  assert.equal(g.service.status().proposals[0].sourceStale,true);assert.throws(()=>g.service.approve(p.proposal.id,{confirmed:true}),error=>error.status===409);
});

test('delivery/read receipt upgrades and later customer input do not invalidate a genuine past human example',async t=>{
  const f=fixture(t),c=await prepare(f);
  f.store.run("UPDATE messages SET status='read' WHERE id=?",c.staffId);f.store.addMessage(c.id,'user','後續新問題');
  f.service.analyze(c.caseId);await until(()=>f.service.status().cases[0].status==='analyzed');
  assert.equal(f.calls[0].input.messages.length,2);assert.equal(f.service.status().proposals[0].sourceStale,false);
});

test('edited knowledge after analysis requires review again and an exact existing memory cannot be duplicated',async t=>{
  const f=fixture(t),r=await analyzed(f);f.store.revise();
  assert.match(f.service.status().proposals[0].questions[0],/知識庫已有更新/);
  assert.throws(()=>f.service.approve(r.proposal.id,{confirmed:true}),error=>error.status===409);
  f.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','same','原有流程','procedure',r.proposal.content,1,null,Date.now());
  assert.throws(()=>f.service.approve(r.proposal.id,{confirmed:true,reviewed:true}),/相同/);
});

test('rejecting a proposal changes neither active knowledge nor revision and cannot revoke an approved memory',async t=>{
  const f=fixture(t),r=await analyzed(f),revision=f.store.value('revision');
  assert.equal(f.service.reject(r.proposal.id).rejected,true);assert.equal(f.service.reject(r.proposal.id).duplicate,true);
  assert.equal(f.store.value('revision'),revision);assert.equal(f.store.get('SELECT COUNT(*) n FROM knowledge').n,0);
  assert.throws(()=>f.service.approve(r.proposal.id,{confirmed:true}),error=>error.status===409);
  const g=fixture(t),p=await analyzed(g);g.service.approve(p.proposal.id,{confirmed:true});
  assert.throws(()=>g.service.reject(p.proposal.id),error=>error.status===409);
});

test('invalid, excessive and personal-data model output is never saved as a proposal or leaked through errors',async t=>{
  for(const mode of ['too-many','private','bad-category','bad-evidence','provider-error']){
    const f=fixture(t,{model:input=>{
      if(mode==='provider-error')throw Error('PRIVATE_SECRET_DIAGNOSTIC');
      const p=proposal(input.messages,mode==='private'?{content:'請找 person@example.test。'}:mode==='bad-category'?{category:'general'}:mode==='bad-evidence'?{evidenceMessageIds:['foreign-message']}:{});
      return {proposals:mode==='too-many'?[p,p,p,p]:[p]};
    }});
    const c=await prepare(f);f.service.analyze(c.caseId);await until(()=>f.service.status().cases[0].status==='failed');
    assert.equal(f.service.status().proposals.length,0);assert.doesNotMatch(JSON.stringify(f.service.status()),/PRIVATE_SECRET|person@example/);
  }
});

test('analysis timeout is bounded even when the model ignores its AbortSignal and does not automatically retry',async t=>{
  const f=fixture(t,{analysisTimeoutMs:20,model:()=>new Promise(()=>{})}),c=await prepare(f);
  f.service.configure({automaticAnalysis:true});f.service.start();
  await until(()=>f.service.status().cases[0].status==='failed');assert.equal(f.service.status().cases[0].lastError,'LEARNING_TIMEOUT');
  await delay(50);assert.equal(f.calls.length,1);assert.equal(f.service.status().proposals.length,0);
});

test('stop aborts promptly and a late model result never accesses a closed store',async t=>{
  let release;const f=fixture(t,{model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})}),c=await prepare(f);
  f.service.analyze(c.caseId);await until(()=>Boolean(release));f.service.stop();
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.store.get('SELECT error_code FROM learning_cases WHERE id=?',c.caseId).error_code,'LEARNING_INTERRUPTED');
  let lateAccess=0;for(const key of ['get','all','run','facts']){const original=f.store[key].bind(f.store);f.store[key]=(...args)=>{if(f.store.closed)lateAccess++;return original(...args);};}
  f.store.close();release();await delay(20);assert.equal(lateAccess,0);
});

test('provider changes discard old analysis and cannot leave a case stuck analyzing',async t=>{
  let release;const f=fixture(t,{model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})}),c=await prepare(f);
  f.service.analyze(c.caseId);await until(()=>Boolean(release));f.engine.agent={configured:false};release();
  await until(()=>f.service.status().cases[0].status==='failed');assert.equal(f.service.status().cases[0].lastError,'LEARNING_PROVIDER_CHANGED');assert.equal(f.service.status().proposals.length,0);
});

test('collection and model analysis are bounded and conversation deletion cascades pending cases without touching active knowledge',async t=>{
  const f=fixture(t),id=f.conversation();
  for(let n=0;n<30;n++)f.store.addMessage(id,'user','合成長對話 '+n+' '+ '文字'.repeat(700));
  f.store.addMessage(id,'staff','請先確認查詢哪件貨品',{status:'accepted'});
  const c=f.service.collect().caseIds[0];f.service.analyze(c);await until(()=>f.service.status().cases[0].status==='analyzed');
  assert.ok(f.calls[0].input.messages.length<=20);assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0].input.messages))<25000);
  f.store.run('DELETE FROM conversations WHERE id=?',id);assert.equal(f.service.status().cases.length,0);assert.equal(f.service.status().proposals.length,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM knowledge').n,0);
});

test('restart marks interrupted analysis failed without replaying it through a newly available model',async t=>{
  const f=fixture(t),c=await prepare(f);f.store.run("UPDATE learning_cases SET status='analyzing' WHERE id=?",c.caseId);f.service.stop();
  const next=createKnowledgeLearning({store:f.store,engine:f.engine,intervalMs:20});t.after(()=>next.stop());
  assert.equal(next.status().cases[0].status,'failed');assert.equal(next.status().cases[0].lastError,'LEARNING_INTERRUPTED');
  next.configure({automaticAnalysis:true});next.start();await delay(45);assert.equal(f.calls.length,0);
});

test('the same suggestion across different human examples is deduplicated while both source cases remain',async t=>{
  const f=fixture(t),first=await analyzed(f),revision=f.store.value('revision');
  const second=await prepare(f);f.service.analyze(second.caseId);await until(()=>f.service.status().cases.find(c=>c.id===second.caseId).status==='analyzed');
  assert.equal(f.calls.length,2);assert.equal(f.service.status().cases.length,2);assert.equal(f.service.status().proposals.length,1);
  assert.equal(f.service.status().proposals[0].id,first.proposal.id);assert.equal(f.store.value('revision'),revision);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM audit WHERE action='learning_proposals_omitted'").n,1);
  assert.deepEqual(f.service.status().limits,{caseLimit:200,visibleCases:100,visibleProposals:100,caseLimitReached:false});
});

test('already approved or previously rejected unchanged content does not repopulate the review queue',async t=>{
  for(const mode of ['existing-knowledge','rejected']){
    const f=fixture(t);
    if(mode==='existing-knowledge')f.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','existing-procedure','已確認處理流程','procedure',proposal([{id:'unused',role:'staff'}]).content,1,null,Date.now());
    else{const first=await analyzed(f);f.service.reject(first.proposal.id);}
    const count=f.service.status().proposals.length,revision=f.store.value('revision'),c=await prepare(f);
    f.service.analyze(c.caseId);await until(()=>f.service.status().cases.find(row=>row.id===c.caseId).status==='analyzed');
    assert.equal(f.service.status().proposals.length,count);assert.equal(f.store.value('revision'),revision);
  }
});

test('native health failure pauses automatic batches until the provider is healthy again',async t=>{
  const f=fixture(t);let healthy=false;f.engine.agent.health=()=>({status:healthy?'connected':'error',lastError:'SYNTHETIC_FAILURE'});
  const c=await prepare(f);f.service.configure({automaticAnalysis:true});f.service.start();
  await delay(45);assert.equal(f.calls.length,0);assert.equal(f.service.status().model.ready,false);
  assert.throws(()=>f.service.analyze(c.caseId),error=>error.status===409);
  healthy=true;await until(()=>f.service.status().cases[0].status==='analyzed');assert.equal(f.calls.length,1);
});

test('disabling automatic analysis aborts its current work and does not silently retry it on reenable',async t=>{
  const f=fixture(t,{model:()=>new Promise(()=>{})});await prepare(f);f.service.configure({automaticAnalysis:true});f.service.start();
  await until(()=>f.calls.length===1);f.service.configure({automaticAnalysis:false});
  await until(()=>f.service.status().cases[0].status==='failed');assert.equal(f.service.status().cases[0].lastError,'LEARNING_DISABLED');
  assert.equal(f.calls[0].options.signal.aborted,true);f.service.configure({automaticAnalysis:true});await delay(45);assert.equal(f.calls.length,1);
});

test('disabling after deferred model settlement but before its save continuation still discards the proposal',async t=>{
  let release;const f=fixture(t,{model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})});
  await prepare(f);f.service.configure({automaticAnalysis:true});f.service.start();await until(()=>Boolean(release));
  release();await Promise.resolve();
  assert.equal(f.service.status().cases[0].status,'analyzing');
  f.service.configure({automaticAnalysis:false});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.service.status().cases[0].status,'failed');assert.equal(f.service.status().cases[0].lastError,'LEARNING_DISABLED');
  assert.equal(f.service.status().proposals.length,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM knowledge').n,0);
});

test('deleting a conversation during model work prevents candidate resurrection',async t=>{
  let release;const f=fixture(t,{model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})}),c=await prepare(f);
  f.service.analyze(c.caseId);await until(()=>Boolean(release));f.store.run('DELETE FROM conversations WHERE id=?',c.id);release();await delay(20);
  assert.equal(f.service.status().cases.length,0);assert.equal(f.service.status().proposals.length,0);
});

test('queued human messages remain dispatchable while collecting, analyzing and rejecting proposals',async t=>{
  const f=fixture(t),c=await prepare(f),revision=f.store.value('revision');
  const pending=f.store.addMessage(c.id,'staff','另一則正在排隊的人工答覆',{status:'queued'});
  f.service.analyze(c.caseId);await until(()=>f.service.status().proposals.length===1);f.service.reject(f.service.status().proposals[0].id);
  const m=f.store.get('SELECT status,config_version FROM messages WHERE id=?',pending);
  assert.equal(m.status,'queued');assert.equal(m.config_version,revision);assert.equal(f.store.value('revision'),revision);
});

test('background analysis defaults to 65 seconds rather than the 25-second customer reply budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const store=new Store(':memory:');let signal;
  const engine={agent:{configured:true,provider:'synthetic',analyzeConversation(input,options){signal=options.signal;return new Promise(()=>{});}}};
  const service=createKnowledgeLearning({store,engine});
  t.after(()=>{service.stop();store.close();});
  store.run('INSERT INTO conversations(id,channel,address,name,state,updated_at) VALUES (?,?,?,?,?,?)','budget-case','web','synthetic-budget','合成預算測試','human',Date.now());
  store.addMessage('budget-case','user','我的貨品幾時到？');store.addMessage('budget-case','staff','請問哪件貨品？',{status:'accepted'});
  const id=service.collect().caseIds[0];service.analyze(id);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.status().cases[0].status,'analyzing');assert.equal(signal.aborted,false);
  t.mock.timers.tick(25000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.status().cases[0].status,'analyzing');assert.equal(signal.aborted,false);
  t.mock.timers.tick(39999);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.status().cases[0].status,'analyzing');assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.status().cases[0].status,'failed');assert.equal(service.status().cases[0].lastError,'LEARNING_TIMEOUT');assert.equal(signal.aborted,true);
});

test('the explicit background budget accepts 65 seconds and rejects values beyond its hard maximum',t=>{
  const store=new Store(':memory:'),engine={agent:{configured:false}};
  t.after(()=>store.close());
  const service=createKnowledgeLearning({store,engine,analysisTimeoutMs:65000});service.stop();
  for(const analysisTimeoutMs of [65001,120000,0,-1,1.5,NaN])assert.throws(()=>createKnowledgeLearning({store,engine,analysisTimeoutMs}),/INVALID_LEARNING_CONFIGURATION/);
});

test('native model timeout codes map to a fixed learning timeout without exposing provider diagnostics',async t=>{
  for(const mode of ['message','code']){
    const f=fixture(t,{analysisTimeoutMs:65000,model:()=>{throw mode==='message'?Error('CODEX_TIMEOUT'):Object.assign(Error('PRIVATE_TIMEOUT_DIAGNOSTIC'),{code:'CODEX_TIMEOUT'});}}),c=await prepare(f);
    f.service.analyze(c.caseId);await until(()=>f.service.status().cases[0].status==='failed');
    assert.equal(f.service.status().cases[0].lastError,'LEARNING_TIMEOUT');assert.equal(f.service.status().proposals.length,0);
    assert.doesNotMatch(JSON.stringify(f.service.status()),/PRIVATE_TIMEOUT_DIAGNOSTIC/);
  }
});

test('stop does not wait for the extended analysis budget and late output still cannot access the closed store',{timeout:2000},async t=>{
  let release;const f=fixture(t,{analysisTimeoutMs:65000,model:input=>new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});})}),c=await prepare(f);
  f.service.analyze(c.caseId);await until(()=>Boolean(release));
  const startedAt=Date.now();await f.service.stop();assert.ok(Date.now()-startedAt<500);
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.store.get('SELECT error_code FROM learning_cases WHERE id=?',c.caseId).error_code,'LEARNING_INTERRUPTED');
  let lateAccess=0;for(const key of ['get','all','run','facts']){const original=f.store[key].bind(f.store);f.store[key]=(...args)=>{if(f.store.closed)lateAccess++;return original(...args);};}
  f.store.close();release();await new Promise(resolve=>setImmediate(resolve));assert.equal(lateAccess,0);
});

test('turning off automatic analysis still cancels promptly with the extended budget',{timeout:2000},async t=>{
  const f=fixture(t,{analysisTimeoutMs:65000,model:()=>new Promise(()=>{})});await prepare(f);f.service.configure({automaticAnalysis:true});f.service.start();
  await until(()=>f.calls.length===1);f.service.configure({automaticAnalysis:false});
  await until(()=>f.service.status().cases[0].status==='failed',500);
  assert.equal(f.service.status().cases[0].lastError,'LEARNING_DISABLED');assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.service.status().proposals.length,0);
});

test('a real Engine manual-send lane completes while extended background analysis is still unresolved',{timeout:2500},async t=>{
  const store=new Store(':memory:');let release,sends=0;
  const agent={configured:true,provider:'synthetic',reply(){throw Error('The human-controlled conversation must not invoke AI reply');},analyzeConversation(input){return new Promise(resolve=>{release=()=>resolve({proposals:[proposal(input.messages)]});});}};
  const engine=new Engine(store,agent,{configured:true,deliveryEnabled:true,instance:'synthetic-learning-budget',async send(){sends++;return {providerId:'synthetic-manual-'+sends};}});
  const service=createKnowledgeLearning({store,engine,analysisTimeoutMs:65000});
  t.after(async()=>{service.stop();await engine.stop();if(!store.closed)store.close();});
  engine.configureInbox({enabled:true,automaticKnowledge:false,aiFallback:false,automaticAi:false});
  const id=engine.receive({channel:'evolution',address:'85255550123@s.whatsapp.net',text:'合成貨品查詢'}).conversationId;
  engine.takeover(id);store.addMessage(id,'staff','先前已提交的合成人工回覆',{status:'accepted'});
  const c=service.collect().caseIds[0];service.analyze(c);await until(()=>Boolean(release));
  const revision=store.value('revision'),outgoingId=engine.manualReply(id,'另一則現在提交的合成人工回覆');
  await engine.tick();assert.equal(sends,1);assert.equal(store.get('SELECT status FROM messages WHERE id=?',outgoingId).status,'accepted');
  assert.equal(service.status().cases[0].status,'analyzing');assert.equal(store.value('revision'),revision);
  service.stop();release();await new Promise(resolve=>setImmediate(resolve));assert.equal(service.status().proposals.length,0);
});
