import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';
// Disposable in-memory fixture. No real credentials and no external calls.
const store=new Store(':memory:'),engine=new Engine(store,createAgent(),createEvolution());
const fetchImpl=async(url)=>{
  // Mock responses only; no request ever leaves this fixture process.
  if(url==='https://api.openai.com/v1/responses')return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({text:'請問你想了解哪項服務？',decision:'clarify',sourceIds:[]})}]}]}));
  if(url.startsWith('https://fixture.example.test/instance/'))return new Response(JSON.stringify({instance:{state:'open'}}));
  throw new Error('External providers disabled for UI QA');
};
store.set('settings',{mode:'review',handoffContact:'原有人工安排（僅測試）'});
const connections=createConnections({engine,store,fetchImpl});
const server=createApp({store,engine,adminToken:'local-ui-test-only-'.repeat(3),workbench:connections,sessionCookieName:'bluesai_workbench_qa_session'});
server.listen(3112,'127.0.0.1',()=>console.log('UI fixture ready at http://127.0.0.1:3112'));
process.on('SIGINT',()=>server.close(()=>{store.close();process.exit(0);}));
