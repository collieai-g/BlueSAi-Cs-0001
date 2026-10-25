import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';
// Disposable in-memory fixture. No real credentials and no external calls.
const runtime=process.argv.includes('--runtime');
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
const server=createApp({store,engine,adminToken:'local-ui-test-only-'.repeat(3),workbench:connections,sessionCookieName:runtime?'bluesai_runtime_qa_session':'bluesai_workbench_qa_session',runtimeMode:runtime,webChatEnabled:runtime,webhookSecret:runtime?'synthetic-webhook-secret-'.repeat(3):''});
const port=runtime?3113:3112;
server.listen(port,'127.0.0.1',()=>{if(runtime)engine.start();console.log(`Synthetic UI fixture ready at http://127.0.0.1:${port}${runtime?'/workbench.html':''}`);});
process.on('SIGINT',()=>server.close(async()=>{await engine.stop();store.close();process.exit(0);}));
