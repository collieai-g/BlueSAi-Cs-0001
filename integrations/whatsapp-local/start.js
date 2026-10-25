import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import makeWASocket, { useMultiFileAuthState, generateMessageIDV2, jidNormalizedUser, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { createLocalBridge, validateDataDirectory } from './bridge.js';

// Some libsignal code logs complete session objects through global console,
// independently of the supplied pino logger. This dedicated bridge process must
// never write those cryptographic objects to a file, terminal or AI transcript.
for(const method of ['log','info','warn','error','debug','trace','dir','dirxml','table','assert'])console[method]=()=>{};
const info=message=>process.stdout.write(message+'\n');
const warning=message=>process.stderr.write(message+'\n');
process.on('uncaughtException',()=>{warning('本機 WhatsApp 接駁發生未處理錯誤，已停止；沒有輸出帳戶或訊息內容。');process.exit(1);});
process.on('unhandledRejection',()=>{warning('本機 WhatsApp 接駁發生非同步錯誤，已停止；請核對服務狀態後再接續。');process.exit(1);});

const [major,minor]=process.versions.node.split('.').map(Number);
if(major!==24||minor<22)throw new Error('請使用 Node.js 24.22 或更新的 24.x。');
if(!process.env.WA_LOCAL_DATA_DIR)throw new Error('請指定倉庫外的 WA_LOCAL_DATA_DIR。');
const dir=validateDataDirectory(resolve(process.env.WA_LOCAL_DATA_DIR));
mkdirSync(dir,{recursive:true,mode:0o700});
const apiPath=resolve(dir,'bridge-api-key');
let apiKey=process.env.WA_LOCAL_API_KEY;
const lockPath=resolve(dir,'bridge.lock');
let lock,bridge;
try{
  lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,String(process.pid));
  if(!apiKey){if(!existsSync(apiPath))writeFileSync(apiPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});apiKey=readFileSync(apiPath,'utf8').trim();}
  const logger=pino({level:'silent'});
  bridge=createLocalBridge({
    dataDir:dir,apiKey,instance:process.env.WA_LOCAL_INSTANCE||'bluesai-local',
    webhookUrl:process.env.WA_LOCAL_WEBHOOK_URL||'',webhookSecret:process.env.WA_LOCAL_WEBHOOK_SECRET||'',
    deliveryEnabled:process.env.WA_LOCAL_DELIVERY_ENABLED==='true',allowTestActivation:process.env.WA_LOCAL_ALLOW_TEST_ACTIVATION==='true',
    testRecipients:(process.env.WA_LOCAL_TEST_RECIPIENTS||'').split(',').map(x=>x.trim()).filter(Boolean),
    loadAuth:useMultiFileAuthState,logger,normalizeJid:jidNormalizedUser,makeMessageId:()=>generateMessageIDV2(),
    makeSocket:config=>makeWASocket({...config,browser:Browsers.ubuntu('Chrome')}),
    encodeQr:raw=>QRCode.toDataURL(raw,{errorCorrectionLevel:'L',width:360,margin:2}),
  });
  const port=Number(process.env.WA_LOCAL_PORT||3105);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('WA_LOCAL_PORT 不正確。');
  bridge.server.listen(port,'127.0.0.1',()=>{
    info(`BlueSAI 本機 WhatsApp 接駁：http://127.0.0.1:${port}`);
    info('尚未連接手機；在客服卡片按「取得二維碼」後才開始真正 WhatsApp 連線。');
    info('只處理本人指定測試號碼；空白名單不轉送來訊、不發送訊息。');
    info(`私人授權資料位置：${dir}`);
  });
  let closing=false;
  const shutdown=async()=>{if(closing)return;closing=true;await bridge.close();closeSync(lock);unlinkSync(lockPath);process.exit(0);};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  bridge.server.on('error',()=>{warning('無法啟動本機 WhatsApp 接駁，請核對連接埠及私人資料鎖。');shutdown().catch(()=>{process.exitCode=1;});});
}catch(error){
  if(lock!==undefined){closeSync(lock);unlinkSync(lockPath);}
  // Deliberately do not print provider errors, credentials, QR values or bodies.
  warning(error.message?.includes('MUST_BE_OUTSIDE_SOURCE')?'WhatsApp 授權資料必須留在程式碼倉庫之外。':'本機 WhatsApp 接駁未能啟動，請核對設定、資料鎖及相依套件。');
  process.exitCode=1;
}
