import { existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,lstatSync,realpathSync,readdirSync } from 'node:fs';
import { resolve,relative,isAbsolute,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createEvolution } from './evolution.js';
import { createCodexAgent } from './codex-agent.js';
import { createConnections,createRuntimeAgent } from './connections.js';
import { createApp } from './server.js';
import { createManagedControl } from './managed-control.js';
import component from '../managed-component.json' with {type:'json'};

const source=resolve(fileURLToPath(new URL('../',import.meta.url)));
const outside=(parent,child)=>{const rel=relative(parent,child);return rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel);};
function safePath(value){
  if(typeof value!=='string'||!isAbsolute(value))throw Error('MANAGED_PATH_MUST_BE_ABSOLUTE');
  const path=resolve(value);
  for(let current=path;;current=dirname(current)){
    if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('MANAGED_PATH_LINK_REJECTED');
    if(existsSync(resolve(current,'.git')))throw Error('PRIVATE_DATA_MUST_BE_OUTSIDE_SOURCE');
    if(current===dirname(current))break;
  }
  if(!outside(source,path)||!outside(path,source))throw Error('PRIVATE_DATA_MUST_BE_OUTSIDE_SOURCE');
  return existsSync(path)?realpathSync(path):path;
}
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('INVALID_MANAGED_CONFIGURATION');return value;}
export function loadManagedConfiguration(file){
  const path=safePath(file);
  if(lstatSync(path).size>65536)throw Error('MANAGED_CONFIGURATION_TOO_LARGE');
  const config=object(JSON.parse(readFileSync(path,'utf8')),['contract_version','component_id','expected_agent_id','data_dir','host','port','initialize','existing_data','web_chat_enabled','provider_config','model_config','webhook_secret_file','native_codex_executable','ingress_policy']);
  if(config.contract_version!==1||config.component_id!==component.component_id||typeof config.expected_agent_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.expected_agent_id)||config.host!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('INVALID_MANAGED_IDENTITY');
  for(const key of ['initialize','existing_data','web_chat_enabled'])if(config[key]!==undefined&&typeof config[key]!=='boolean')throw Error('INVALID_MANAGED_CONFIGURATION');
  if(config.ingress_policy!==undefined&&!['retry_503','manual_pause'].includes(config.ingress_policy))throw Error('INVALID_MANAGED_INGRESS_POLICY');
  config.data_dir=safePath(config.data_dir);
  if(config.native_codex_executable!==undefined)config.native_codex_executable=safePath(config.native_codex_executable);
  return config;
}
function privateSecret(config,path,required=false){
  if(!path){if(required)throw Error('MANAGED_SECRET_REQUIRED');return '';}
  const actual=safePath(path);
  if(outside(config.data_dir,actual)||actual===config.data_dir||!lstatSync(actual).isFile())throw Error('MANAGED_SECRET_MUST_BELONG_TO_DATA');
  const value=readFileSync(actual,'utf8').trim();
  if(value.length<32||value.length>8192)throw Error('INVALID_MANAGED_SECRET');
  return value;
}

export async function startManagedRuntime(config,{token=process.env.BLUEPRINT_MODULE_TOKEN,releaseId=process.env.BLUEPRINT_MODULE_RELEASE_ID}={}){
  if(typeof token!=='string'||token.length<32||token.length>256||typeof releaseId!=='string'||!/^[a-f0-9]{64}$/.test(releaseId))throw Error('INVALID_MANAGED_IDENTITY');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major!==24||minor<22)throw Error('MANAGED_RUNTIME_REQUIRES_NODE_24_22');
  const data=safePath(config.data_dir),dbPath=resolve(data,'service.sqlite'),ownerPath=resolve(data,'managed-owner.json');
  for(const path of [dbPath,ownerPath,resolve(data,'admin-token')])safePath(path);
  if(!existsSync(data)){if(config.initialize!==true)throw Error('MANAGED_DATA_MISSING');mkdirSync(data,{recursive:true,mode:0o700});}
  if(existsSync(ownerPath)){
    const owner=JSON.parse(readFileSync(ownerPath,'utf8'));
    if(owner.component_id!==component.component_id||owner.expected_agent_id!==config.expected_agent_id)throw Error('MANAGED_DATA_IDENTITY_MISMATCH');
    if(!existsSync(dbPath))throw Error('MANAGED_DATABASE_MISSING');
  }else if(existsSync(dbPath)){
    if(config.existing_data!==true)throw Error('MANAGED_EXISTING_DATA_REQUIRES_ADOPTION');
  }else if(config.initialize!==true)throw Error('MANAGED_DATA_MISSING');
  if(!existsSync(dbPath)&&!existsSync(ownerPath)&&readdirSync(data).length)throw Error('MANAGED_DATA_NOT_EMPTY');
  if(existsSync(dbPath)){
    const probe=new DatabaseSync(dbPath,{readOnly:true});
    try{if(probe.prepare('SELECT MAX(version) version FROM schema_migrations').get().version!==component.database_schema)throw Error('MANAGED_SCHEMA_MIGRATION_REQUIRED');}finally{probe.close();}
  }
  const lockPath=resolve(data,'service.lock');
  const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,String(process.pid));
  let store,engine,server,control,connections,closed=false,shutdownWork=null;
  function releaseLock(){closeSync(lock);if(existsSync(lockPath)&&readFileSync(lockPath,'utf8')===String(process.pid))unlinkSync(lockPath);}
  try{
    const adminPath=resolve(data,'admin-token');
    if(!existsSync(adminPath)){if(config.initialize!==true||existsSync(dbPath)||existsSync(ownerPath))throw Error('MANAGED_ADMIN_TOKEN_MISSING');writeFileSync(adminPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}
    const adminToken=privateSecret({...config,data_dir:data},adminPath,true);
    store=new Store(dbPath);
    if(!existsSync(ownerPath))writeFileSync(ownerPath,JSON.stringify({contract_version:1,component_id:component.component_id,expected_agent_id:config.expected_agent_id})+'\n',{flag:'wx',mode:0o600});
    const ai=object(config.model_config||{},['model','api_key_file']);
    const aiConfig={model:ai.model,apiKey:privateSecret({...config,data_dir:data},ai.api_key_file)};
    const provider=object(config.provider_config||{},['url','instance','api_key_file','delivery_enabled']);
    if(provider.delivery_enabled!==undefined&&typeof provider.delivery_enabled!=='boolean')throw Error('INVALID_MANAGED_PROVIDER');
    const providerConfig={url:provider.url,instance:provider.instance,apiKey:privateSecret({...config,data_dir:data},provider.api_key_file),deliveryEnabled:provider.delivery_enabled===true};
    const agent=createRuntimeAgent(store,aiConfig);
    engine=new Engine(store,agent,createEvolution(providerConfig));
    engine.setRuntimeVersion({component_id:component.component_id,version:component.version,release_id:releaseId});
    const webhookSecret=privateSecret({...config,data_dir:data},config.webhook_secret_file);
    connections=createConnections({engine,store,runtime:true,providerConfig,aiConfig,publicBaseUrl:`http://127.0.0.1:${config.port}`,webhookSecret,
      nativeAgentFactory:config.native_codex_executable?()=>createCodexAgent({executable:config.native_codex_executable,runtimeDir:resolve(data,'codex-jobs')}):null});
    const shutdown=async()=>{
      if(closed)return;
      if(shutdownWork)return shutdownWork;
      shutdownWork=(async()=>{
        await control.drain();
        await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
        await connections.stopAutoReceive();await engine.stop();control.checkpoint();store.close();releaseLock();closed=true;
      })();
      try{await shutdownWork;}catch(error){shutdownWork=null;throw error;}
    };
    control=createManagedControl({token,releaseId,version:component.version,expectedAgentId:config.expected_agent_id,engine,store,ingressPolicy:config.ingress_policy,shutdown:()=>shutdown().catch(()=>{process.exitCode=1;})});
    server=createApp({store,engine,adminToken,webhookSecret,workbench:connections,runtimeMode:true,webChatEnabled:config.web_chat_enabled===true,managedControl:control});
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',done);});
    engine.start();control.markReady();
    return {server,store,engine,control,shutdown,status:control.status};
  }catch(error){
    if(server?.listening)await new Promise(done=>server.close(done));
    await engine?.stop();store?.close();releaseLock();throw error;
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('MANAGED_CONFIG_ARGUMENT_REQUIRED');
    const instance=await startManagedRuntime(loadManagedConfiguration(process.argv[3]));
    process.on('SIGINT',()=>void instance.shutdown().catch(()=>{process.exitCode=1;}));
    process.on('SIGTERM',()=>void instance.shutdown().catch(()=>{process.exitCode=1;}));
    process.stdout.write('BlueSAI managed runtime ready; paused until installer resume.\n');
  }catch(error){process.stderr.write('BlueSAI managed runtime failed: '+(/^[A-Z0-9_]+$/.test(error.message)?error.message:'MANAGED_START_FAILED')+'\n');process.exitCode=1;}
}
