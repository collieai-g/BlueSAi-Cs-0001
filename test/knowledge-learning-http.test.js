import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {createApp} from '../src/server.js';

const ns='/api/agents/bluesai-cs-0001',token='synthetic-learning-owner-'.repeat(3);
async function fixture(t){
 const store=new Store(':memory:');let trainingCalls=0,analysisCalls=0;
 const agent={configured:true,provider:'synthetic',async reply(){throw Error('unexpected reply');},
  async learn(){trainingCalls++;return {remember:true,title:'先識別查詢',content:'缺少貨品資料時先問清楚貨品。',category:'procedure',text:'請核對處理流程。'};},
  async analyzeConversation(input){analysisCalls++;return {proposals:[{kind:'procedure',title:'貨品查詢流程',content:'查詢到貨時間而欠缺貨品資料時，先確認是哪件貨品；未有物流依據時不承諾日期。',category:'procedure',rationale:'人工示範先釐清貨品，沒有承諾時效。',evidenceMessageIds:[input.messages.find(m=>m.role==='staff').id],questions:[]}]};}};
 const engine=new Engine(store,agent,{configured:true,deliveryEnabled:true,instance:'synthetic-channel',async send(){return {providerId:'synthetic-delivery'};}});
 engine.configureInbox({enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
 const workbench={status:()=>({ai:{status:'connected'},whatsapp:{localTest:false}})};
 const server=createApp({store,engine,workbench,adminToken:token});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const login=await fetch(origin+ns+'/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(path,method='GET',body,extra={})=>{const r=await fetch(origin+ns+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await engine.stop();store.close();});
 return {store,engine,api,origin,counts:()=>({trainingCalls,analysisCalls})};
}

test('learning APIs require owner login, same origin and explicit automatic-analysis consent',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+ns+'/knowledge-learning')).status,401);
 assert.equal((await f.api('/knowledge-learning','PUT',{automaticAnalysis:true})).status,400);
 assert.equal((await f.api('/knowledge-learning','PUT',{automaticAnalysis:true,consent:true},{Origin:'https://foreign.invalid'})).status,403);
 const revision=f.store.value('revision');
 assert.equal((await f.api('/knowledge-learning','PUT',{automaticAnalysis:true,consent:true})).status,200);
 assert.equal((await f.api('/knowledge-learning')).data.settings.automaticAnalysis,true);
 assert.equal(f.store.value('revision'),revision);
});

test('manual delivery collects once, analyzes asynchronously and requires explicit approval before procedural use',async t=>{
 const f=await fixture(t),r=f.engine.receive({channel:'evolution',address:'85255550133@s.whatsapp.net',text:'貨品幾時到？'});
 f.engine.takeover(r.conversationId);const staff=f.engine.manualReply(r.conversationId,'請問你想查哪件貨品？');
 await f.api('/knowledge-learning/collect','POST',{});
 assert.equal((await f.api('/knowledge-learning')).data.cases.length,0);
 await f.engine.tick();assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',staff).status,'accepted');
 await f.api('/knowledge-learning/collect','POST',{});await f.api('/knowledge-learning/collect','POST',{});
 const state=(await f.api('/knowledge-learning')).data;assert.equal(state.cases.length,1);assert.equal(state.model.ready,true);
 const revision=f.store.value('revision');
 assert.equal((await f.api('/knowledge-learning/cases/'+state.cases[0].id+'/analyze','POST',{})).status,202);
 let proposals=[];for(let n=0;n<50;n++){proposals=(await f.api('/knowledge-learning')).data.proposals;if(proposals.length)break;await delay(5);}
 assert.equal(proposals.length,1);assert.equal(f.store.facts().length,0);assert.equal(f.store.value('revision'),revision);
 assert.equal(proposals[0].kind,'procedure');assert.equal(proposals[0].evidence[0].role,'staff');
 const path='/knowledge-learning/proposals/'+proposals[0].id+'/approve';
 assert.equal((await f.api(path,'POST',{})).status,400);
 assert.equal((await f.api(path,'POST',{confirmed:true,title:'先識別貨品',content:proposals[0].content,category:'procedure'})).status,200);
 assert.equal(f.store.facts()[0].category,'procedure');assert.equal(f.store.value('revision'),revision+1);
 assert.deepEqual(f.counts(),{trainingCalls:0,analysisCalls:1});
});

test('knowledge-first mode still invokes a connected teaching model and keeps its procedure pending',async t=>{
 const f=await fixture(t);
 const c=f.engine.receive({channel:'evolution',address:'85255550136@s.whatsapp.net',text:'請人工處理'});f.engine.takeover(c.conversationId);
 const queued=f.engine.manualReply(c.conversationId,'合成並行人工回覆。'),revision=f.store.value('revision');
 const r=await f.api('/training','POST',{text:'客人問貨品到貨時間，先了解哪款貨品。'});
 assert.equal(r.status,201);assert.equal(f.counts().trainingCalls,1);
 assert.equal(f.store.facts().length,0);
 assert.equal(f.store.get('SELECT category FROM knowledge').category,'procedure');
 assert.equal(f.store.value('revision'),revision);await f.engine.tick();assert.equal(f.store.get('SELECT status FROM messages WHERE id=?',queued).status,'accepted');
});

test('semantic fallback accepts approved factual support while procedure-guided questions remain drafts',async t=>{
 const f=await fixture(t);
 const fact=f.engine.addFaq({question:'合成工作室有甚麼功能？',answer:'合成工作室提供卡片管理。',approved:true});
 f.engine.agent.reply=async()=>({text:'你可以使用卡片管理。',decision:'answer',sourceIds:[fact.knowledgeId],procedureIds:[],engine:'synthetic'});
 const c=f.engine.receive({channel:'evolution',address:'85255550134@s.whatsapp.net',text:'我想逐張卡管理，可以嗎？'});
 await f.engine.tick();
 const answer=f.store.messages(c.conversationId).find(m=>m.role==='assistant');assert.ok(answer);assert.deepEqual(answer.sources,[fact.knowledgeId]);
 assert.ok(['queued','accepted'].includes(answer.status));
 f.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)','synthetic-process','到貨查詢次序','procedure','未知道貨品時先確認是哪件貨品。',1,null,Date.now());f.store.revise();
 f.engine.agent.reply=async()=>({text:'請問是哪件貨品？',decision:'clarify',sourceIds:[],procedureIds:['synthetic-process'],engine:'synthetic'});
 const p=f.engine.receive({channel:'evolution',address:'85255550135@s.whatsapp.net',text:'件貨幾時到？'});await f.engine.tick();
 const question=f.store.messages(p.conversationId).find(m=>m.role==='assistant');assert.equal(question.status,'draft');assert.deepEqual(question.sources,['synthetic-process']);
});
