import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';
// Disposable in-memory fixture. No real credentials and no external calls.
const runtime=process.argv.includes('--runtime'),receiveGuidance=process.argv.includes('--receive-guidance'),autoReceive=process.argv.includes('--auto-receive'),autoReceiveError=process.argv.includes('--auto-receive-error'),automaticReplies=process.argv.includes('--automatic-replies'),inboxDetails=process.argv.includes('--inbox-details');
if(runtime&&receiveGuidance||autoReceive&&autoReceiveError||(autoReceive||autoReceiveError)&&!receiveGuidance||automaticReplies&&!autoReceive||inboxDetails&&(!receiveGuidance||runtime))throw new Error('Choose one synthetic fixture mode.');
const providerConfig=runtime?{url:'https://fixture.example.test',instance:'synthetic-ui',apiKey:'not-a-real-provider-key',deliveryEnabled:false}:{};
const store=new Store(':memory:'),engine=new Engine(store,createAgent(),createEvolution(providerConfig));
let webhook;
const fetchImpl=async(url,options={})=>{
  // Mock responses only; no request ever leaves this fixture process.
  if(url==='https://api.openai.com/v1/responses')return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({text:'請問你想了解哪項服務？',decision:'clarify',sourceIds:[]})}]}]}));
  if(url.startsWith('https://fixture.example.test/instance/'))return new Response(JSON.stringify({instance:{state:'open'}}));
  if(url.startsWith('https://fixture.example.test/webhook/set/')){webhook=JSON.parse(options.body).webhook;return new Response(JSON.stringify({webhook}));}
  if(url.startsWith('https://fixture.example.test/webhook/find/'))return new Response(JSON.stringify({webhook}));
  throw new Error('External providers disabled for UI QA');
};
store.set('settings',{mode:'review',handoffContact:'原有人工安排（僅測試）'});
const connections=createConnections({engine,store,fetchImpl,runtime,providerConfig,publicBaseUrl:runtime?'http://127.0.0.1:3113':'',webhookSecret:runtime?'synthetic-webhook-secret-'.repeat(3):''});
// This mode exercises inbox setup visibility with synthetic metadata only.
// It never starts a bridge, receives a real message, or calls an external model.
if(receiveGuidance){
  if(automaticReplies){
    store.set('inbox_policy',{enabled:true,automaticKnowledge:true,aiFallback:true,automaticAi:true});
    // Metadata and policy validation only. Even an unexpected worker invocation
    // cannot call a real model or channel from this isolated UI fixture.
    engine.agent={configured:true,provider:'synthetic-ui',reply:async()=>{throw new Error('Synthetic UI fixture never runs model inference');}};
  }
  const originalStatus=connections.status;
  const auto=autoReceive||autoReceiveError,ready=autoReceive;
  const scope={available:true,mode:ready?'all_private_text':'test',consented:ready,replyToReceived:ready,includeSelfTests:false};
  connections.status=()=>{const state=originalStatus();return {...state,...(automaticReplies?{ai:{...state.ai,status:'connected',provider:'openai',model:'synthetic-only'}}:{}),whatsapp:{...state.whatsapp,status:'open',checkedAt:Date.now(),linkedPhone:null,receiveSetupAvailable:true,receiveEnabled:ready,automaticRepliesAvailable:automaticReplies,inboxReplyEnabled:ready,...(auto?{autoReceiveOnConnect:true,autoReceiveStatus:ready?'receiving':'error'}:{}),inboxScope:{...scope},webhook:{configured:true,registered:ready},readiness:{...state.whatsapp.readiness,canSend:ready},selfTestReply:{available:false,enabled:false,automaticFaq:false}}};};
  connections.getInboxScope=async()=>({...scope});
}
// Synthetic inbox records only: use normal read APIs and the real source/revision
// checks, while never starting a worker, phone bridge, inference or live sender.
if(inboxDetails){
  store.set('inbox_policy',{enabled:true,automaticKnowledge:true,aiFallback:automaticReplies,automaticAi:automaticReplies});
  const fact=engine.addFaq({question:'合成示例：服務時間？',answer:'合成示例：星期一至五 09:00–18:00。',approved:true});
  const id='synthetic-details-thread',incoming=Date.now()-120000,answerTime=incoming+30000;
  store.run('INSERT INTO conversations(id,channel,address,name,state,last_customer_at,updated_at) VALUES (?,?,?,?,?,?,?)',id,'evolution','synthetic-details-contact','示例客戶（合成資料）','ai',incoming,answerTime);
  const question=store.addMessage(id,'user','合成示例：服務時間？');
  const answer=store.addMessage(id,'assistant','合成示例：星期一至五 09:00–18:00。',{status:'accepted',engine:'knowledge',decision:'answer',sources:[fact.knowledgeId]});
  store.run('UPDATE messages SET created_at=? WHERE id=?',incoming,question);
  store.run('UPDATE messages SET created_at=? WHERE id=?',answerTime,answer);
  store.run('UPDATE conversations SET updated_at=? WHERE id=?',answerTime,id);
}
const server=createApp({store,engine,adminToken:'local-ui-test-only-'.repeat(3),workbench:connections,sessionCookieName:runtime?'bluesai_runtime_qa_session':'bluesai_workbench_qa_session',runtimeMode:runtime,webChatEnabled:runtime,webhookSecret:runtime?'synthetic-webhook-secret-'.repeat(3):''});
const override=process.argv.find(value=>value.startsWith('--port='));
const port=override?Number(override.slice('--port='.length)):runtime?3113:3112;
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid synthetic fixture port.');
server.listen(port,'127.0.0.1',()=>{if(runtime)engine.start();console.log(`Synthetic UI fixture ready at http://127.0.0.1:${port}${runtime?'/workbench.html':''}`);});
process.on('SIGINT',()=>server.close(async()=>{await engine.stop();store.close();process.exit(0);}));
