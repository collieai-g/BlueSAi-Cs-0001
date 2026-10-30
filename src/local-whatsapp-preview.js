import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { validateDataDirectory } from '../integrations/whatsapp-local/bridge.js';
import { ServiceError } from './engine.js';

const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entry=resolve(sourceRoot,'integrations/whatsapp-local/start.js');
const messages={
  LOCAL_WHATSAPP_DEPENDENCIES_MISSING:'本機 WhatsApp 接駁元件尚未安裝完成，請先由安裝人員準備。',
  LOCAL_WHATSAPP_LOCKED:'本機接駁資料仍由程序鎖定，請先核對原有服務；沒有刪除鎖或另開程序。',
  LOCAL_WHATSAPP_START_FAILED:'本機 WhatsApp 接駁未成功啟動，請由安裝人員核對元件及私人資料位置。',
  LOCAL_WHATSAPP_STOPPED:'本機接駁已停止；請重新按連結，現有登入資料仍然保留。',
  LOCAL_WHATSAPP_STOP_FAILED:'尚未確認本機接駁程序已結束，請先核對原有程序；不會另開第二個程序。',
};
const failure=code=>Object.assign(new Error(messages[code]),{code});
function checkDependencies(){
  const require=createRequire(entry);
  try{for(const name of ['@whiskeysockets/baileys','qrcode','pino'])require.resolve(name);}
  catch{throw failure('LOCAL_WHATSAPP_DEPENDENCIES_MISSING');}
}
async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}
function privateChildEnvironment(dataDir,port,instance,apiKey,callbackUrl,webhookSecret,allowInitialCallbackUpgrade,autoReceive){
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(?:WA_LOCAL_|EVOLUTION_|OPENAI_|BLUEPRINT_|BLUESAI_|LOCAL_WHATSAPP_|WEBHOOK_|DELIVERY_|WEB_CHAT_)/.test(name)||['ADMIN_TOKEN','HOST','PORT','PUBLIC_BASE_URL','COOKIE_SECURE','NODE_OPTIONS','NODE_PATH'].includes(name))delete env[name];
  return {...env,WA_LOCAL_DATA_DIR:dataDir,WA_LOCAL_PORT:String(port),WA_LOCAL_INSTANCE:instance,WA_LOCAL_API_KEY:apiKey,
    WA_LOCAL_DELIVERY_ENABLED:'false',WA_LOCAL_ALLOW_TEST_ACTIVATION:'false',WA_LOCAL_TEST_RECIPIENTS:'',WA_LOCAL_WEBHOOK_URL:callbackUrl,WA_LOCAL_WEBHOOK_SECRET:webhookSecret,
    WA_LOCAL_PREVIEW_CALLBACK_UPGRADE:allowInitialCallbackUpgrade?callbackUrl:'',WA_LOCAL_REQUIRE_INBOX_RECONSENT:'true',WA_LOCAL_PREVIEW_AUTO_RECEIVE:autoReceive?'true':'false'};
}

// One preview owns one idle bridge. No process is started by construction or GET.
// Injection points exercise process lifecycle without a real phone or provider.
export function createLocalWhatsAppPreview({dataDir,callbackUrl='',webhookSecret='',autoReceive=false,spawn=fork,fetchImpl=fetch,dependencyCheck=checkDependencies,allocatePort=freePort,startupMs=15000,shutdownMs=3000,exitWaitMs=1000}={}){
  const bridgeData=validateDataDirectory(resolve(dataDir,'whatsapp-link'));
  const instance='preview-'+createHash('sha256').update(bridgeData).digest('hex').slice(0,16);
  if(callbackUrl){const parsed=new URL(callbackUrl);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||!parsed.port||parsed.pathname!=='/webhooks/evolution'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.href!==callbackUrl||webhookSecret.length<32)throw new Error('INVALID_PREVIEW_CALLBACK');}
  const callbackMarker=resolve(bridgeData,'inbox-callback');
  let callbackActive=existsSync(callbackMarker);
  if(callbackActive&&readFileSync(callbackMarker,'utf8')!==callbackUrl)throw new Error('PREVIEW_CALLBACK_IDENTITY_CHANGED');
  let state={available:true,status:'not_started',stage:'idle'},child=null,connection=null,preparing=null,closed=false;
  const status=()=>({...state,phoneLinkOnly:!callbackActive,inboxSetupAvailable:Boolean(callbackUrl),callbackReady:callbackActive&&ready(),canReceive:false,canSend:false});
  const ready=()=>state.status==='ready'&&child!==null&&connection!==null;
  function waitReady(process){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(failure('LOCAL_WHATSAPP_START_FAILED')),startupMs);
      const onMessage=value=>{if(value?.type==='bluesai:bridge-ready')finish();};
      const onError=()=>finish(failure('LOCAL_WHATSAPP_START_FAILED'));
      function finish(error){clearTimeout(timer);process.off('message',onMessage);process.off('error',onError);process.off('exit',onError);error?reject(error):resolve();}
      process.on('message',onMessage);process.once('error',onError);process.once('exit',onError);
    });
  }
  async function stopOwned(){
    const owned=child;if(!owned)return;
    await new Promise(resolve=>{
      let done=false,killTimer=null;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);owned.off('exit',finish);resolve();};
      const kill=()=>{try{owned.kill();}catch{}if(!done)killTimer=setTimeout(finish,exitWaitMs);};
      const timer=setTimeout(kill,shutdownMs);
      owned.once('exit',finish);
      try{if(owned.connected)owned.send({type:'bluesai:bridge-stop'},error=>{if(error)kill();});else kill();}catch{kill();}
    });
    connection=null;
  }
  async function start({allowInitialCallbackUpgrade=false}={}){
    state={available:true,status:'preparing',stage:'checking_dependencies'};
    await dependencyCheck();if(closed)throw failure('LOCAL_WHATSAPP_STOPPED');
    mkdirSync(bridgeData,{recursive:true,mode:0o700});
    if(existsSync(resolve(bridgeData,'bridge.lock')))throw failure('LOCAL_WHATSAPP_LOCKED');
    const tokenPath=resolve(bridgeData,'bridge-api-key');
    if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
    const apiKey=readFileSync(tokenPath,'utf8').trim();
    if(apiKey.length<32)throw failure('LOCAL_WHATSAPP_START_FAILED');
    const port=await allocatePort();if(closed)throw failure('LOCAL_WHATSAPP_STOPPED');
    const url='http://127.0.0.1:'+port;
    state={available:true,status:'preparing',stage:'starting'};
    const owned=spawn(entry,[],{execPath:process.execPath,execArgv:[],cwd:dirname(entry),windowsHide:true,detached:false,
      env:privateChildEnvironment(bridgeData,port,instance,apiKey,callbackActive?callbackUrl:'',callbackActive?webhookSecret:'',allowInitialCallbackUpgrade,autoReceive),stdio:['ignore','ignore','ignore','ipc']});
    child=owned;
    owned.on('error',()=>{if(child===owned&&state.status==='ready'){
      connection=null;state={available:true,status:'error',stage:'stopping',code:'LOCAL_WHATSAPP_STOP_FAILED',message:messages.LOCAL_WHATSAPP_STOP_FAILED};
      void stopOwned().then(()=>{if(!closed&&!child&&state.code==='LOCAL_WHATSAPP_STOP_FAILED')state={available:true,status:'error',stage:'stopped',code:'LOCAL_WHATSAPP_STOPPED',message:messages.LOCAL_WHATSAPP_STOPPED};});
    }});
    owned.on('exit',()=>{if(child===owned){child=null;connection=null;if(!closed&&state.status==='ready')state={available:true,status:'error',stage:'stopped',code:'LOCAL_WHATSAPP_STOPPED',message:messages.LOCAL_WHATSAPP_STOPPED};}});
    await waitReady(owned);if(closed||child!==owned)throw failure('LOCAL_WHATSAPP_STOPPED');
    const response=await fetchImpl(url+'/instance/connectionState/'+instance,{headers:{apikey:apiKey},signal:AbortSignal.timeout(2000),redirect:'error'});
    const observed=response.ok?await response.json():null;
    if(observed?.provider!=='baileys-local'||observed.instance?.instanceName!==instance||observed.instance?.state!=='close'||observed.testMode?.deliveryEnabled!==false||(!callbackActive&&observed.webhook?.enabled!==false))throw failure('LOCAL_WHATSAPP_START_FAILED');
    if(closed||child!==owned)throw failure('LOCAL_WHATSAPP_STOPPED');
    connection={url,instance,apiKey};state={available:true,status:'ready',stage:'ready',message:'本機接駁服務已準備，可取得真正二維碼；收件及發送保持關閉。'};
  }
  return {
    status,
    hasSavedAuth:()=>existsSync(resolve(bridgeData,'auth','creds.json')),
    connection:()=>ready()?{...connection}:null,
    owns:value=>Boolean(ready()&&value&&Object.keys(connection).every(key=>value[key]===connection[key])),
    async enableInbox(){
      if(!callbackUrl||closed||preparing||(child&&!ready())||(!callbackActive&&!ready()))throw new ServiceError('本機收件接駁尚未就緒，請先連結 WhatsApp。',409);
      if(callbackActive&&ready())return status();
      // This marker fixes the callback identity across later process restarts.
      // Only the explicit owner registration action reaches this method.
      if(!callbackActive){writeFileSync(callbackMarker,callbackUrl,{flag:'wx',mode:0o600});callbackActive=true;}
      state={available:true,status:'preparing',stage:'restarting_for_inbox'};
      await stopOwned();
      if(child){state={available:true,status:'error',stage:'stopping',code:'LOCAL_WHATSAPP_STOP_FAILED',message:messages.LOCAL_WHATSAPP_STOP_FAILED};throw new ServiceError(messages.LOCAL_WHATSAPP_STOP_FAILED,409);}
      try{await start({allowInitialCallbackUpgrade:true});}catch(error){await stopOwned();const code=child?'LOCAL_WHATSAPP_STOP_FAILED':Object.hasOwn(messages,error.code)?error.code:'LOCAL_WHATSAPP_START_FAILED';state={available:true,status:'error',stage:'error',code,message:messages[code]};throw new ServiceError(messages[code],502);}
      return status();
    },
    prepare(input){
      if(!input||input.consent!==true||Object.keys(input).some(key=>key!=='consent'))throw new ServiceError('請確認由此預覽啟動自己的本機 WhatsApp 接駁。');
      if(closed)throw new ServiceError(messages.LOCAL_WHATSAPP_STOPPED,409);
      if(child&&!ready()&&!preparing)throw new ServiceError(messages.LOCAL_WHATSAPP_STOP_FAILED,409);
      if(!ready()&&!preparing){
        preparing=start().catch(async error=>{
          await stopOwned();const code=child?'LOCAL_WHATSAPP_STOP_FAILED':Object.hasOwn(messages,error.code)?error.code:'LOCAL_WHATSAPP_START_FAILED';
          if(!closed)state={available:true,status:'error',stage:'error',code,message:messages[code]};
        }).finally(()=>{preparing=null;});
      }
      return status();
    },
    async close(){closed=true;await stopOwned();await preparing;connection=null;state=child?{available:false,status:'error',stage:'stopping',code:'LOCAL_WHATSAPP_STOP_FAILED',message:messages.LOCAL_WHATSAPP_STOP_FAILED}:{available:false,status:'not_started',stage:'stopped'};},
  };
}
