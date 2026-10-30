import { mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createAgent } from './agent.js';
import { createCodexAgent } from './codex-agent.js';
import { createEvolution } from './evolution.js';
import { createConnections } from './connections.js';
import { createApp } from './server.js';
import { createLocalWhatsAppPreview } from './local-whatsapp-preview.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=resolve(process.env.BLUESAI_WORKBENCH_DATA||resolve(homedir(),'.bluesai-local-workbench'));
const rel=relative(root,dir);if(!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw new Error('資料必須在程式碼目錄之外。');
mkdirSync(dir,{recursive:true,mode:0o700});
const lockPath=resolve(dir,'service.lock');
const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,String(process.pid));
let store,server,localWhatsAppPreview,engine;
try{
  const tokenPath=resolve(dir,'admin-token');
  if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const adminToken=readFileSync(tokenPath,'utf8').trim();
  store=new Store(resolve(dir,'workbench.sqlite'));
  const port=Number(process.env.BLUESAI_WORKBENCH_PORT||3101);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_WORKBENCH_PORT');
  const webhookPath=resolve(dir,'webhook-secret');
  if(!existsSync(webhookPath))writeFileSync(webhookPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const webhookSecret=readFileSync(webhookPath,'utf8').trim();
  // Same private store: the owner's chosen local preview starts receiving after
  // the linked account is verified, following the saved reply policy for new arrivals.
  engine=new Engine(store,createAgent(),createEvolution(),{localInbox:true});
  const publicBaseUrl='http://127.0.0.1:'+port;
  localWhatsAppPreview=createLocalWhatsAppPreview({dataDir:dir,callbackUrl:publicBaseUrl+'/webhooks/evolution',webhookSecret,autoReceive:true});
  const connections=createConnections({engine,store,localWhatsAppPreview,allowNativePreview:true,allowLocalInboxPreview:true,autoReceivePreview:true,publicBaseUrl,webhookSecret,
    nativeAgentFactory:()=>createCodexAgent({executable:process.env.BLUESAI_CODEX_BIN||'codex',runtimeDir:resolve(dir,'codex-jobs')})});
  server=createApp({store,engine,adminToken,webhookSecret,workbench:connections,sessionCookieName:'bluesai_workbench_session'});
  server.listen(port,'127.0.0.1',()=>{connections.startAutoReceive();console.log(`BlueSAi-Cs-0001 本機工作台：http://127.0.0.1:${port}\n管理員密碼位置：${tokenPath}\n自動回覆依已啟用的知識庫／AI 政策運作。`);});
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close(async()=>{await connections.stopAutoReceive();await engine.stop();await localWhatsAppPreview.close();store.close();closeSync(lock);unlinkSync(lockPath);process.exit(0);});};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  server.on('error',async()=>{await connections.stopAutoReceive();await engine.stop();await localWhatsAppPreview.close();store.close();closeSync(lock);unlinkSync(lockPath);console.error('無法啟動本機工作台，請檢查連接埠。');process.exitCode=1;});
}catch(error){await engine?.stop();await localWhatsAppPreview?.close();store?.close();closeSync(lock);unlinkSync(lockPath);throw error;}
