import { mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createAgent } from './agent.js';
import { createEvolution } from './evolution.js';
import { createConnections } from './connections.js';
import { createApp } from './server.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=resolve(process.env.BLUESAI_WORKBENCH_DATA||resolve(homedir(),'.bluesai-local-workbench'));
const rel=relative(root,dir);if(!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw new Error('資料必須在程式碼目錄之外。');
mkdirSync(dir,{recursive:true,mode:0o700});
const lockPath=resolve(dir,'service.lock');
const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,String(process.pid));
let store,server;
try{
  const tokenPath=resolve(dir,'admin-token');
  if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const adminToken=readFileSync(tokenPath,'utf8').trim();
  store=new Store(resolve(dir,'workbench.sqlite'));
  // This local configuration workbench never starts a delivery worker or webhooks.
  const engine=new Engine(store,createAgent(),createEvolution());
  const connections=createConnections({engine,store});
  server=createApp({store,engine,adminToken,workbench:connections,sessionCookieName:'bluesai_workbench_session'});
  const port=Number(process.env.BLUESAI_WORKBENCH_PORT||3101);
  server.listen(port,'127.0.0.1',()=>console.log(`BlueSAi-Cs-0001 本機工作台：http://127.0.0.1:${port}\n管理員密碼位置：${tokenPath}\n對客訊息發送關閉。`));
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close(()=>{store.close();closeSync(lock);unlinkSync(lockPath);process.exit(0);});};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  server.on('error',()=>{store.close();closeSync(lock);unlinkSync(lockPath);console.error('無法啟動本機工作台，請檢查連接埠。');process.exitCode=1;});
}catch(error){store?.close();closeSync(lock);unlinkSync(lockPath);throw error;}
