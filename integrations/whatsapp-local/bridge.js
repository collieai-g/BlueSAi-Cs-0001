import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const phonePattern = /^[1-9]\d{7,14}$/;
const phoneJid = /^([1-9]\d{7,14})@s\.whatsapp\.net$/;
const statusNames = { 0: 'ERROR', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'PLAYED' };
const equal = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const json = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
const object = value => value && typeof value==='object' && !Array.isArray(value);
const normalizedUser = jid => typeof jid==='string'?jid.replace(/^(\d+)(?:_\d+)?(?::\d+)?@(s\.whatsapp\.net|lid|hosted|hosted\.lid)$/,'$1@$2'):'';
function plainText(content){
  // Baileys emits raw upserts before normalizing disappearing-message wrappers.
  // Unwrap only ephemeral text; never unwrap view-once, media or edited content.
  for(let depth=0;depth<5&&object(content);depth++){
    if(content.viewOnceMessage||content.viewOnceMessageV2||content.viewOnceMessageV2Extension||content.documentWithCaptionMessage||content.editedMessage||content.imageMessage||content.videoMessage||content.audioMessage||content.documentMessage)return undefined;
    if(content.ephemeralMessage){content=content.ephemeralMessage.message;continue;}
    return content.conversation??content.extendedTextMessage?.text;
  }
  return undefined;
}

export function validateNumbers(value) {
  if (!Array.isArray(value) || value.length>3 || value.some(number=>typeof number!=='string'||!phonePattern.test(number)) || new Set(value).size!==value.length) throw fail('請填寫最多三個含國家／地區碼的測試電話號碼。');
  return [...value];
}

// Resolve only an explicit provider-supplied phone alias. Never turn an LID into
// a phone number by changing its suffix, and never accept groups/broadcasts.
export function resolvePhoneAddress(key,normalizeJid=normalizedUser) {
  if (!key || typeof key.remoteJid!=='string') return null;
  const remote=normalizeJid(key.remoteJid),direct=remote.match(phoneJid);
  if (direct) return direct[1]+'@s.whatsapp.net';
  const alternate=typeof key.remoteJidAlt==='string'?normalizeJid(key.remoteJidAlt):'';
  if (/^\d+@lid$/.test(remote) && phoneJid.test(alternate)) return alternate;
  return null;
}

// Socket.user is Baileys' getter for authState.creds.me. Accept only explicit
// phone identities; an LID suffix is never treated as a telephone number.
export function resolveLinkedPhone(socket,authState,normalizeJid=normalizedUser) {
  const phones=[socket?.user?.id,authState?.creds?.me?.id].map(value=>typeof value==='string'?normalizeJid(value):'').filter(value=>phoneJid.test(value));
  const unique=[...new Set(phones)];
  return unique.length===1?unique[0].split('@')[0]:null;
}

export function validateDataDirectory(path) {
  if (typeof path!=='string' || !isAbsolute(path)) throw new Error('WA_LOCAL_DATA_DIR_REQUIRED');
  const packageRoot=dirname(fileURLToPath(import.meta.url));
  let codeRoot=packageRoot, at=packageRoot;
  while (true) { if (existsSync(resolve(at,'.git'))) { codeRoot=at; break; } const parent=dirname(at); if(parent===at)break; at=parent; }
  let existing=resolve(path);
  while(!existsSync(existing)){const parent=dirname(existing);if(parent===existing)throw new Error('PRIVATE_PARENT_REQUIRED');existing=parent;}
  const actual=resolve(realpathSync(existing),relative(existing,resolve(path)));
  // A copied private runtime must also reject another checkout, rather than only
  // protecting the directory from which this particular JS file was imported.
  let candidateParent=realpathSync(existing);
  while(true){if(existsSync(resolve(candidateParent,'.git')))throw new Error('WHATSAPP_AUTH_MUST_BE_OUTSIDE_SOURCE');const parent=dirname(candidateParent);if(parent===candidateParent)break;candidateParent=parent;}
  const rel=relative(realpathSync(codeRoot),actual);
  if (!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))) throw new Error('WHATSAPP_AUTH_MUST_BE_OUTSIDE_SOURCE');
  return actual;
}

function callbackConfig(url,secret) {
  if (!url && !secret) return null;
  if (typeof secret!=='string'||secret.length<32) throw new Error('WA_LOCAL_WEBHOOK_SECRET_TOO_SHORT');
  const parsed=new URL(url);
  if (parsed.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname!=='/webhooks/evolution') throw new Error('LOCAL_CALLBACK_MUST_BE_LOOPBACK_EVOLUTION_PATH');
  return {enabled:true,url:parsed.href,headers:{Authorization:`Bearer ${secret}`},byEvents:false,base64:false,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']};
}

async function body(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail('需要 JSON 格式。',415);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>16384)throw fail('內容太長。',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(value))throw Error();return value;}catch{throw fail('JSON 內容不正確。');}
}

// The adapter never creates example QR codes or example WhatsApp messages. Tests
// inject an EventEmitter socket; the CLI supplies the actual Baileys socket.
export function createLocalBridge({ dataDir, instance='bluesai-local', apiKey, webhookUrl='', webhookSecret='', deliveryEnabled=false, allowTestActivation=false, testRecipients=[], makeSocket, loadAuth, encodeQr, logger, fetchImpl=fetch, now=Date.now, qrWaitMs=10000, flushIntervalMs=1000, normalizeJid=normalizedUser, makeMessageId=()=>randomUUID().replaceAll('-','').toUpperCase() }={}) {
  if(typeof apiKey!=='string'||apiKey.length<32)throw new Error('WA_LOCAL_API_KEY_TOO_SHORT');
  if(typeof instance!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(instance))throw new Error('INVALID_LOCAL_INSTANCE');
  if([makeSocket,loadAuth,encodeQr].some(fn=>typeof fn!=='function'))throw new Error('REAL_PROVIDER_FACTORY_REQUIRED');
  if(!Number.isInteger(flushIntervalMs)||flushIntervalMs<1||flushIntervalMs>60000)throw new Error('INVALID_CALLBACK_INTERVAL');
  dataDir=validateDataDirectory(dataDir);mkdirSync(dataDir,{recursive:true,mode:0o700});
  const expectedWebhook=callbackConfig(webhookUrl,webhookSecret);
  const db=new DatabaseSync(resolve(dataDir,'bridge.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS bridge_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS callback_outbox(id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS local_sends(id TEXT PRIMARY KEY,address TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observed_inbox_contacts(address TEXT PRIMARY KEY,account TEXT NOT NULL,last_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observed_message_events(event_key TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS self_test_inputs(request_id TEXT NOT NULL,account TEXT NOT NULL,address TEXT NOT NULL,grant_id TEXT NOT NULL,timestamp INTEGER NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(request_id,account,address));
    CREATE TABLE IF NOT EXISTS self_test_operations(operation_id TEXT PRIMARY KEY,account TEXT NOT NULL,address TEXT NOT NULL,grant_id TEXT NOT NULL,request_id TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL,send_id TEXT NOT NULL,provider_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS local_send_aliases(alias_id TEXT PRIMARY KEY,send_id TEXT NOT NULL,address TEXT NOT NULL);`);
  db.prepare("UPDATE self_test_operations SET state='uncertain' WHERE state='sending'").run();
  const config=key=>{const r=db.prepare('SELECT value FROM bridge_config WHERE key=?').get(key);return r?JSON.parse(r.value):null;};
  const setConfig=(key,value)=>db.prepare('INSERT INTO bridge_config VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  const identity={instance,callback:webhookUrl||''};
  const previous=config('identity');
  if(previous && JSON.stringify(previous)!==JSON.stringify(identity)){db.close();throw new Error('LOCAL_BRIDGE_IDENTITY_CHANGED_USE_NEW_DATA_DIRECTORY');}
  if(!previous)setConfig('identity',identity);
  let recipients=validateNumbers(config('recipients')??testRecipients), sendEnabled=deliveryEnabled===true;
  if(!config('recipients'))setConfig('recipients',recipients);
  const savedInboxScope=config('inbox_scope');
  let inboxAccount=typeof savedInboxScope?.account==='string'&&phonePattern.test(savedInboxScope.account)?savedInboxScope.account:null;
  let inboxMode=savedInboxScope?.mode==='all_private_text'&&Number.isSafeInteger(savedInboxScope.consentedAt)&&inboxAccount?'all_private_text':'test',inboxGeneration=0,inboxReplyEnabled=false;
  let inboxConsentedAt=inboxMode==='all_private_text'?savedInboxScope.consentedAt:null;
  let includeSelfTests=inboxMode==='all_private_text'&&savedInboxScope.includeSelfTests===true&&Number.isSafeInteger(savedInboxScope.selfTestConsentedAt);
  let selfTestConsentedAt=includeSelfTests?savedInboxScope.selfTestConsentedAt:null;
  let testConsentedAt=Number.isSafeInteger(config('test_consented_at'))?config('test_consented_at'):now();
  if(savedInboxScope?.mode==='all_private_text'&&inboxMode!=='all_private_text')setConfig('inbox_scope',{mode:'test',consentedAt:null,account:null});
  let webhookEnabled=Boolean(expectedWebhook&&config('webhook_enabled'));
  let state='close',socket=null,linkedAuthState=null,opening=null,stopped=false,epoch=0,qrGeneration=0,qr=null,qrAt=0,lastReason='',retryTimer=null,flushBusy=false,saveChain=Promise.resolve();
  let ignored=0,reconnectAttempt=0,sendsThisMinute=0,sendWindow=now(),mappingState='not_requested',mappingGeneration=0,testChanging=false,scopeChanging=0,scopeBaseline=null;
  // Reply authority is deliberately process-local. Stored inputs/operations and
  // send IDs survive restart, but none can reopen a grant or retry a send.
  let selfReply=null,selfReplyGeneration=0,selfInFlight=false,selfHeld=[],selfSendsThisMinute=0,selfSendWindow=now();
  // Process-local metadata only: never retain message text, keys, names, JIDs,
  // phone numbers, QR material or provider exception strings in diagnostics.
  const diagnostics={scope:'process',startedAt:now(),upserts:{events:0,notify:0,append:0,other:0,requestId:0,messageCount:0,lastAt:null},
    rejected:{eventType:0,requestId:0,invalidKey:0,stale:0,nonText:0,oversize:0,unmapped:0,outOfScope:0,self:0,knownEcho:0,contextChanged:0,scopeClosed:0},
    queued:{incoming:0,outgoing:0,selfTest:0,duplicate:0,lastAt:null},callbacks:{success:0,failure:0,lastSuccessAt:null,lastFailureAt:null},lastRejection:{reason:null,at:null}};
  const receiveDiagnostics=()=>({...diagnostics,upserts:{...diagnostics.upserts},rejected:{...diagnostics.rejected},queued:{...diagnostics.queued},callbacks:{...diagnostics.callbacks},lastRejection:{...diagnostics.lastRejection}});
  // Observe only fixed stage categories. Raw node counts are observations, not
  // proof of successful pairing or refresh handling. No node, auth value or
  // provider error is copied here, and this never changes the handshake.
  const linkStages={scope:'process',authMode:'not_started',socketEvents:'not_started',qrEvents:0,pairSuccess:0,companionRegRefresh:0,isNewLogin:0,open:0,
    closeCodes:{code401:0,code403:0,code408:0,code411:0,code428:0,code440:0,code500:0,code503:0,code515:0,other:0}};
  const closeStageCodes=new Set([401,403,408,411,428,440,500,503,515]);
  const incrementStage=(target,key)=>{target[key]=Math.min(Number.MAX_SAFE_INTEGER,target[key]+1);};
  const connectionDiagnostics=()=>({...linkStages,closeCodes:{...linkStages.closeCodes}});
  function reject(reason,count=1){diagnostics.rejected[reason]+=count;diagnostics.lastRejection={reason,at:now()};}
  const inboxScope=()=>{if(inboxMode==='all_private_text'&&state==='open')inboxAccountValid();return {mode:inboxMode,consented:inboxMode==='all_private_text',includeSelfTests,supported:['new_private_text',...(includeSelfTests?['self_test_text']:[])],excluded:['history','groups','broadcasts',...(includeSelfTests?[]:['self_messages']),'media'],sendingScope:'test_allowlist',replyScope:'recent_incoming_only',replyToReceived:inboxReplyEnabled,deliveryEnabled:inboxReplyEnabled};};
  const status=()=>({instance:{instanceName:instance,state},provider:'baileys-local',qrAvailable:Boolean(qr&&now()-qrAt<20000),qrExpiresInMs:qr?Math.max(0,20000-(now()-qrAt)):0,lastReason,inboxScope:inboxScope(),selfTestReply:selfReplyStatus(),testMode:{count:recipients.length,maskedNumbers:recipients.map(number=>'••••'+number.slice(-4)),deliveryEnabled:sendEnabled,activationAvailable:allowTestActivation,mappingState},webhook:{configured:Boolean(expectedWebhook),enabled:webhookEnabled,pending:db.prepare('SELECT count(*) AS n FROM callback_outbox').get().n},ignoredOutsideTestScope:ignored,receiveDiagnostics:receiveDiagnostics(),connectionDiagnostics:connectionDiagnostics()});
  const scoped=address=>recipients.includes(address.split('@')[0]);
  const inboundScoped=address=>phoneJid.test(address)&&(inboxMode==='all_private_text'?inboxAccountValid():scoped(address));
  function inboxAccountValid(){
    if(inboxMode!=='all_private_text'||state!=='open')return false;
    if(inboxAccount&&resolveLinkedPhone(socket,linkedAuthState,normalizeJid)===inboxAccount)return true;
    closeSelfReply();inboxMode='test';inboxAccount=null;inboxConsentedAt=null;includeSelfTests=false;selfTestConsentedAt=null;scopeBaseline=null;inboxGeneration++;mappingGeneration++;sendEnabled=false;inboxReplyEnabled=false;
    setConfig('inbox_scope',{mode:'test',consentedAt:null,account:null});lastReason='inbox_account_changed';purgeOutOfScope();
    return false;
  }
  function closeSelfReply(){
    selfReply=null;selfReplyGeneration++;
    // A callback already waiting for the core must not carry obsolete authority.
    for(const row of db.prepare('SELECT id,payload FROM callback_outbox').all()){
      let payload;try{payload=JSON.parse(row.payload);}catch{continue;}
      if(payload.data?.localSelfTest===true&&payload.data.selfReplyGrantId){payload.data.selfReplyGrantId=null;db.prepare('UPDATE callback_outbox SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id);}
    }
  }
  function selfReplyValid(){
    if(!selfReply)return false;
    if(!includeSelfTests||!inboxAccountValid()||selfReply.account!==inboxAccount){closeSelfReply();return false;}
    return true;
  }
  function selfReplyStatus(){return {enabled:selfReplyValid(),automaticFaq:selfReply?.automaticFaq===true,grantId:selfReply?.grantId||null,available:true,requiresNewMessage:true};}
  function findLocalSend(id){
    if(typeof id!=='string')return null;
    const direct=db.prepare('SELECT id,address FROM local_sends WHERE id=?').get(id);
    const sent=direct||db.prepare('SELECT s.id,s.address FROM local_send_aliases a JOIN local_sends s ON s.id=a.send_id WHERE a.alias_id=? AND a.address=s.address').get(id);
    return sent?{...sent,selfReply:Boolean(db.prepare('SELECT operation_id FROM self_test_operations WHERE send_id=?').get(sent.id))}:null;
  }
  const recentIncoming=address=>{
    const account=resolveLinkedPhone(socket,linkedAuthState,normalizeJid);
    if(!account||address===account+'@s.whatsapp.net')return false;
    const observed=db.prepare('SELECT account,last_at FROM observed_inbox_contacts WHERE address=?').get(address);
    return Boolean(observed&&observed.account===account&&now()>=observed.last_at&&now()-observed.last_at<86400000);
  };
  const canReplyTo=address=>inboxMode==='all_private_text'&&inboxReplyEnabled&&inboxAccountValid()&&recentIncoming(address);
  const allowedCallback=payload=>{
    const address=payload.data?.key?.remoteJid||payload.data?.remoteJid;
    if(typeof address!=='string'||!phoneJid.test(address))return false;
    if(payload.sourceScope==='all_private_text'&&!inboxAccountValid())return false;
    if(payload.data?.localSelfTest!==undefined){
      const seconds=Number(payload.data.messageTimestamp);
      return payload.data.localSelfTest===true&&payload.event==='messages.upsert'&&typeof payload.data.key?.fromMe==='boolean'&&payload.sourceScope==='all_private_text'&&includeSelfTests&&inboxAccountValid()&&address===inboxAccount+'@s.whatsapp.net'&&Number.isFinite(seconds)&&seconds>=Math.floor(selfTestConsentedAt/1000);
    }
    if(payload.event==='messages.upsert'&&payload.data?.key?.fromMe===false)return inboundScoped(address);
    if(payload.event==='messages.upsert'&&payload.data?.key?.fromMe===true&&inboxMode==='all_private_text')return inboxAccountValid()&&recentIncoming(address);
    if(payload.event==='messages.update'&&typeof payload.data?.keyId==='string'){
      const sent=findLocalSend(payload.data.keyId);
      if(sent?.address===address)return true;
    }
    return scoped(address);
  };
  function purgeOutOfScope(){
    for(const row of db.prepare('SELECT id,payload FROM callback_outbox').all()){
      let allowed=false;try{allowed=allowedCallback(JSON.parse(row.payload));}catch{}
      if(!allowed)db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);
    }
  }
  function purgeSelfTestCallbacks(){
    for(const row of db.prepare('SELECT id,payload FROM callback_outbox').all()){
      let self=false;try{self=JSON.parse(row.payload).data?.localSelfTest===true;}catch{}
      if(self)db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);
    }
  }
  async function prepareMappings(numbers) {
    if(!numbers.length){mappingState='not_requested';return;}
    const mappingEpoch=epoch,mappingSocket=socket,generation=++mappingGeneration;
    const current=()=>!stopped&&state==='open'&&epoch===mappingEpoch&&socket===mappingSocket&&generation===mappingGeneration;
    const mappings=mappingSocket?.signalRepository?.lidMapping;
    if(typeof mappings?.getLIDForPN!=='function'){mappingState='not_available';throw fail('這個接駁版本未提供電話識別映射，請先更新接駁服務。',409);}
    mappingState='checking';
    let timeout;
    try {
      // Query only the numbers for which the owner just gave test consent. No
      // account-wide history download or contact enumeration is required.
      const values=await Promise.race([Promise.all(numbers.map(number=>mappings.getLIDForPN(number+'@s.whatsapp.net'))),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('mapping_timeout')),8000);})]);
      if(!current())throw Error('mapping_context_changed');
      if(values.some(value=>typeof value!=='string'||!/^\d+@lid$/.test(normalizeJid(value))))throw Error('mapping_unresolved');
      mappingState='ready';
    }catch{const stale=!current();if(!stale)mappingState='not_resolved';throw Object.assign(fail('尚未確認測試號碼的 WhatsApp 身份，請核對含地區碼的號碼並稍後再試。',409),{stale});}finally{clearTimeout(timeout);}
  }
  async function phoneAddress(key,{knownSend=false}={}) {
    const direct=resolvePhoneAddress(key,normalizeJid);
    const stored=knownSend&&typeof key?.id==='string'?findLocalSend(key.id):null;
    if(direct)return stored&&stored.address!==direct?null:direct;
    if(typeof key?.remoteJid!=='string'||!/^\d+@lid$/.test(normalizeJid(key.remoteJid)))return null;
    // Direct delivery receipts may omit remoteJidAlt. A known random outgoing ID
    // is bound to the address saved before dispatch; it is not a suffix guess.
    if(stored)return stored.address;
    const lookup=socket?.signalRepository?.lidMapping?.getPNForLID;
    if(typeof lookup==='function'){
      try{const mapped=normalizeJid(await lookup.call(socket.signalRepository.lidMapping,normalizeJid(key.remoteJid)));if(phoneJid.test(mapped))return mapped;}catch{}
    }
    // Self-chat can use the authenticated account's own LID before the SDK has
    // cached a PN mapping. Only an exact, nonconflicting explicit own alias is
    // usable, and only for the separately consented read-only self-test route.
    if(!knownSend&&includeSelfTests&&inboxMode==='all_private_text'&&inboxAccountValid()){
      const aliases=[socket?.user?.lid,linkedAuthState?.creds?.me?.lid].filter(value=>value!=null&&value!=='');
      if(aliases.some(value=>typeof value!=='string'||!/^\d+@lid$/.test(normalizeJid(value))))return null;
      const unique=[...new Set(aliases.map(value=>normalizeJid(value)))],ownPhone=resolveLinkedPhone(socket,linkedAuthState,normalizeJid);
      if(unique.length===1&&unique[0]===normalizeJid(key.remoteJid)&&ownPhone===inboxAccount)return ownPhone+'@s.whatsapp.net';
    }
    return null;
  }
  function queue(event,eventKey,data,sourceScope,observedAt=now()) {
    const payload={event,instance,data,...(sourceScope==='all_private_text'?{sourceScope}: {})};
    const insert=()=>db.prepare('INSERT OR IGNORE INTO callback_outbox(id,event_key,payload,next_at,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),eventKey,JSON.stringify(payload),now(),now()).changes>0;
    if(event!=='messages.upsert')return insert();
    db.exec('BEGIN IMMEDIATE');
    try{
      const unseen=db.prepare('INSERT OR IGNORE INTO observed_message_events VALUES (?,?)').run(eventKey,now()).changes>0;
      const added=unseen&&insert();
      if(added&&data.localSelfTest===true&&typeof data.selfReplyGrantId==='string'&&selfReplyValid()&&data.selfReplyGrantId===selfReply.grantId){
        db.prepare('INSERT OR IGNORE INTO self_test_inputs VALUES (?,?,?,?,?,?)').run(data.key.id,selfReply.account,data.key.remoteJid,selfReply.grantId,Math.min(now(),Number(data.messageTimestamp)*1000),observedAt);
      }
      db.exec('COMMIT');return added;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function queueSelf(item,readonly=false){
    if(stopped||item.epoch!==epoch||item.inboxGeneration!==inboxGeneration||!includeSelfTests||!inboxAccountValid()||item.address!==inboxAccount+'@s.whatsapp.net')return;
    const known=findLocalSend(item.id);
    if(known?.address===item.address){reject('knownEcho');return;}
    const grant=!readonly&&item.replyGeneration===selfReplyGeneration&&selfReplyValid()&&item.replyGrantId===selfReply.grantId&&item.observedAt>=selfReply.at&&item.seconds>=Math.floor(selfReply.at/1000)?selfReply.grantId:null;
    const inserted=queue('messages.upsert',`self-test:${item.id}`,{key:{id:item.id,remoteJid:item.address,fromMe:item.fromMe},messageTimestamp:item.seconds,message:{conversation:item.content},pushName:item.pushName,localSelfTest:true,selfReplyGrantId:grant},'all_private_text',item.observedAt);
    if(inserted){diagnostics.queued.selfTest++;diagnostics.queued.lastAt=now();}else diagnostics.queued.duplicate++;
  }
  function drainSelfHeld(readonly=false){const held=selfHeld;selfHeld=[];for(const item of held)queueSelf(item,readonly);}
  async function flush() {
    if(stopped||flushBusy||scopeChanging||!webhookEnabled||!expectedWebhook)return;
    flushBusy=true;
    try {
      // Drain a bounded batch so a burst does not wait one second per message.
      for(let batch=0;batch<25&&!stopped&&webhookEnabled&&!scopeChanging;batch++){
        const row=db.prepare('SELECT * FROM callback_outbox WHERE next_at<=? ORDER BY created_at LIMIT 1').get(now());
        if(!row)return;
        // Revoked queued bodies must never be forwarded on a later retry.
        const payload=JSON.parse(row.payload);
        // Preserve consented queued bodies during a normal offline restart, but
        // do not forward any until the linked account has actually reopened.
        if(payload.sourceScope==='all_private_text'&&inboxMode==='all_private_text'&&state!=='open')return;
        if(!allowedCallback(payload)){db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);continue;}
        try {
          const response=await fetchImpl(expectedWebhook.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{...expectedWebhook.headers,'Content-Type':'application/json'},body:row.payload});
          if(!response.ok)throw Error();
          diagnostics.callbacks.success++;diagnostics.callbacks.lastSuccessAt=now();
          db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);
        } catch {
          diagnostics.callbacks.failure++;diagnostics.callbacks.lastFailureAt=now();
          db.prepare('UPDATE callback_outbox SET attempts=attempts+1,next_at=? WHERE id=?').run(now()+Math.min(60000,1000*2**Math.min(row.attempts,6)),row.id);
        }
      }
    } finally {flushBusy=false;}
  }
  async function onMessages(event,expectedEpoch) {
    diagnostics.upserts.events++;diagnostics.upserts.lastAt=now();
    diagnostics.upserts[event?.type==='notify'?'notify':event?.type==='append'?'append':'other']++;
    const count=Array.isArray(event?.messages)?event.messages.length:0;
    diagnostics.upserts.messageCount+=count;if(event?.requestId)diagnostics.upserts.requestId++;
    if(!event||!['notify','append'].includes(event.type)||!Array.isArray(event.messages)){reject('eventType',count);return;}
    if(scopeChanging){reject('scopeClosed',count);return;}
    if(inboxMode==='all_private_text'&&!inboxAccountValid()){ignored+=count;reject('scopeClosed',count);return;}
    if(inboxMode==='test'&&!recipients.length){ignored+=count;reject('outOfScope',count);return;}
    const receivedGeneration=inboxGeneration;
    const receivedReplyGeneration=selfReplyGeneration,receivedReplyGrant=selfReply?.grantId||null,observedAt=now();
    for(const message of event.messages){
      if(!object(message)){reject('invalidKey');continue;}
      const id=message.key?.id,fromMe=message.key?.fromMe;
      if(typeof id!=='string'||!id||id.length>300||typeof fromMe!=='boolean'){reject('invalidKey');continue;}
      const seconds=Number(message.messageTimestamp);
      // Validate freshness and text before resolving the identity of an arrival.
      const consentedAt=inboxMode==='all_private_text'?inboxConsentedAt:testConsentedAt;
      if(!Number.isFinite(seconds)||seconds*1000<now()-300000||seconds*1000>now()+60000||seconds<Math.floor(consentedAt/1000)){reject('stale');continue;}
      const content=plainText(message.message);
      if(typeof content!=='string'||!content.trim()||content.length>4000){ignored++;reject(typeof content==='string'&&content.length>4000?'oversize':'nonText');continue;}
      const address=await phoneAddress(message.key,{knownSend:Boolean(findLocalSend(id))});
      if(stopped||expectedEpoch!==epoch||receivedGeneration!==inboxGeneration){reject('contextChanged');return;}
      if(!address){ignored++;reject('unmapped');continue;}
      if(findLocalSend(id)?.address===address){reject('knownEcho');continue;}
      const ownAddress=inboxMode==='all_private_text'&&resolveLinkedPhone(socket,linkedAuthState,normalizeJid)===address.split('@')[0];
      const localSelfTest=ownAddress&&includeSelfTests&&inboxAccountValid();
      if(ownAddress&&!localSelfTest){ignored++;reject('self');continue;}
      if(localSelfTest&&seconds<Math.floor(selfTestConsentedAt/1000)){reject('stale');continue;}
      if(localSelfTest){
        const item={id,address,fromMe,seconds,content,pushName:typeof message.pushName==='string'?message.pushName.slice(0,100):'WhatsApp 自傳測試',epoch:expectedEpoch,inboxGeneration:receivedGeneration,replyGeneration:receivedReplyGeneration,replyGrantId:receivedReplyGrant,observedAt};
        if(selfInFlight&&selfInFlight.epoch===epoch){if(selfHeld.length>=32){closeSelfReply();drainSelfHeld(true);}selfHeld.push(item);}
        else queueSelf(item);
        continue;
      }
      if(!localSelfTest&&(fromMe===false?!inboundScoped(address):inboxMode==='all_private_text'?!(inboxAccountValid()&&recentIncoming(address)):!scoped(address))){ignored++;reject('outOfScope');continue;}
      if(!fromMe&&!localSelfTest){
        const account=resolveLinkedPhone(socket,linkedAuthState,normalizeJid);
        if(account)db.prepare('INSERT INTO observed_inbox_contacts(address,account,last_at) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET account=excluded.account,last_at=CASE WHEN account=excluded.account THEN MAX(last_at,excluded.last_at) ELSE excluded.last_at END').run(address,account,Math.min(now(),seconds*1000));
      }
      const inserted=queue('messages.upsert',`message:${id}`,{key:{id,remoteJid:address,fromMe},messageTimestamp:seconds,message:{conversation:content},pushName:typeof message.pushName==='string'?message.pushName.slice(0,100):'WhatsApp 來訊'},inboxMode);
      if(inserted){diagnostics.queued[fromMe?'outgoing':'incoming']++;diagnostics.queued.lastAt=now();}else diagnostics.queued.duplicate++;
    }
  }
  async function onUpdates(updates,expectedEpoch) {
    if(!Array.isArray(updates))return;
    for(const item of updates){const known=findLocalSend(item.key?.id);if(item.key?.fromMe!==true&&!(item.key?.fromMe===false&&known?.selfReply))continue;const address=await phoneAddress(item.key,{knownSend:true}),id=item.key?.id,status=statusNames[item.update?.status];if(stopped||expectedEpoch!==epoch)return;if(!address||typeof id!=='string'||!id||!status)continue;const sent=findLocalSend(id);if(!scoped(address)&&sent?.address!==address)continue;queue('messages.update',`receipt:${id}:${status}`,{keyId:id,remoteJid:address,fromMe:true,status,...(sent?.selfReply?{localSelfReply:true}:{})});}
  }
  function onReceipt(updates,expectedEpoch) {
    if(!Array.isArray(updates))return;
    return onUpdates(updates.map(item=>({key:item.key,update:{status:item.receipt?.readTimestamp?4:item.receipt?.receiptTimestamp?3:undefined}})),expectedEpoch);
  }
  async function connect() {
    if(stopped)throw fail('接駁服務已停止。',503);
    if(socket&&state!=='close')return;
    if(opening)return opening;
    opening=(async()=>{
      let saved;do{saved=saveChain;await saved;}while(saved!==saveChain);
      if(stopped)throw fail('接駁服務已停止。',503);
      const current=++epoch;state='connecting';lastReason='';qrGeneration++;qr=null;qrAt=0;
      const auth=await loadAuth(resolve(dataDir,'auth'));
      if(stopped||current!==epoch)throw fail('接駁服務已停止。',503);
      linkedAuthState=auth.state;
      linkStages.authMode=auth.state.creds.me==null?'new_registration':'existing_login';
      linkStages.socketEvents='unavailable';
      // The SDK applies this raw-node filter before cleanMessage canonicalizes
      // hosted private addresses. Let only its recognized private hosted forms
      // reach that canonicalizer; final forwarding still requires verified PN.
      const candidate=makeSocket({auth:auth.state,logger,markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>{const value=normalizeJid(jid);return !phoneJid.test(value)&&!/^\d+@lid$/.test(value)&&!/^([1-9]\d{7,14})@hosted$/.test(value)&&!/^\d+@hosted\.lid$/.test(value);},getMessage:async()=>undefined});
      socket=candidate;
      if(typeof candidate.ws?.on==='function'){
        linkStages.socketEvents='available';
        const observeStage=key=>()=>{if(current===epoch&&!stopped&&socket===candidate)incrementStage(linkStages,key);};
        candidate.ws.on('CB:iq,,pair-success',observeStage('pairSuccess'));
        candidate.ws.on('CB:notification,type:companion_reg_refresh',observeStage('companionRegRefresh'));
      }
      candidate.ev.on('creds.update',()=>{if(current!==epoch||stopped)return;saveChain=saveChain.then(()=>auth.saveCreds()).catch(()=>{if(current!==epoch||stopped)return;closeSelfReply();lastReason='credential_save_failed';state='close';sendEnabled=false;inboxReplyEnabled=false;candidate.end(new Error('credential_save_failed'));});});
      candidate.ev.on('messages.upsert',event=>{if(current===epoch&&!stopped)onMessages(event,current).catch(()=>{lastReason='incoming_mapping_failed';});});
      candidate.ev.on('messages.update',event=>{if(current===epoch&&!stopped)onUpdates(event,current).catch(()=>{lastReason='receipt_mapping_failed';});});
      candidate.ev.on('message-receipt.update',event=>{if(current===epoch&&!stopped)onReceipt(event,current)?.catch(()=>{lastReason='receipt_mapping_failed';});});
      candidate.ev.on('connection.update',update=>{
        if(current!==epoch||stopped)return;
        if(socket===candidate){
          if(typeof update.qr==='string')incrementStage(linkStages,'qrEvents');
          if(update.isNewLogin===true)incrementStage(linkStages,'isNewLogin');
          if(update.connection==='open')incrementStage(linkStages,'open');
          if(update.connection==='close'){
            const code=update.lastDisconnect?.error?.output?.statusCode;
            incrementStage(linkStages.closeCodes,typeof code==='number'&&closeStageCodes.has(code)?'code'+code:'other');
          }
        }
        if(typeof update.qr==='string'){
          const raw=update.qr,generation=++qrGeneration;qr=null;qrAt=0;
          encodeQr(raw).then(image=>{if(current===epoch&&generation===qrGeneration&&!stopped&&state==='connecting'){qr=image;qrAt=now();}}).catch(()=>{if(current===epoch&&generation===qrGeneration&&!stopped&&state==='connecting')lastReason='qr_encoding_failed';});
        }
        if(update.connection==='open'){state='open';qrGeneration++;qr=null;qrAt=0;lastReason='';reconnectAttempt=0;if(inboxMode==='all_private_text')inboxAccountValid();if(recipients.length)prepareMappings(recipients).catch(error=>{if(error.stale||current!==epoch||stopped||state!=='open'||socket!==candidate)return;sendEnabled=false;lastReason='recipient_mapping_unresolved';});}
        if(update.connection==='close'){
          closeSelfReply();state='close';qrGeneration++;qr=null;qrAt=0;socket=null;sendEnabled=false;inboxReplyEnabled=false;
          const code=update.lastDisconnect?.error?.output?.statusCode;
          lastReason=code===401?'logged_out':code===403?'account_not_available':'connection_closed';
          if([401,403].includes(code)){sendEnabled=false;return;}
          if(!stopped&&reconnectAttempt<5){const attempt=reconnectAttempt++,delay=code===515?500:Math.min(30000,1000*2**attempt);retryTimer=setTimeout(()=>connect().catch(()=>{lastReason='reconnect_failed';state='close';}),delay);retryTimer.unref();}
        }
      });
    })().catch(()=>{state='close';socket=null;lastReason='connection_start_failed';throw fail('WhatsApp 連線未能啟動，請核對網絡及已連結裝置。',502);}).finally(()=>{opening=null;});
    return opening;
  }
  const timer=setInterval(()=>flush().catch(()=>{lastReason='callback_storage_failed';}),flushIntervalMs);timer.unref();
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{status:'ok',provider:'baileys-local'});
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers.apikey,apiKey))throw fail('未獲授權。',401);
      if(path===`/instance/connectionState/${instance}`&&req.method==='GET')return json(res,200,status());
      if(path===`/instance/selfTestReply/${instance}`){
        if(req.method==='GET')return json(res,200,selfReplyStatus());
        if(req.method==='PUT'){
          closeSelfReply();const generation=selfReplyGeneration;
          const input=await body(req);
          if(generation!==selfReplyGeneration)throw fail('自身測試授權已改變，請重新核對。',409);
          if(Object.keys(input).some(key=>!['enabled','automaticFaq','consent'].includes(key))||typeof input.enabled!=='boolean'||typeof input.automaticFaq!=='boolean'||input.consent!==true)throw fail('請明確確認本人測試及知識庫自動回覆。',409);
          if(input.enabled){
            if(scopeChanging||!includeSelfTests||!inboxAccountValid()||!webhookEnabled||(selfInFlight&&selfInFlight.epoch===epoch))throw fail('請先核對連結帳戶、自傳收件及收件網址；進行中的發送須先完成。',409);
            selfReply={account:inboxAccount,grantId:randomUUID(),automaticFaq:input.automaticFaq,at:now()};
          }
          return json(res,200,selfReplyStatus());
        }
      }
      if(path===`/instance/connect/${instance}`&&req.method==='GET'){
        await connect();const until=Date.now()+qrWaitMs;
        while(state==='connecting'&&!(qr&&now()-qrAt<20000)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,100));
        return json(res,200,{...status(),base64:qr&&now()-qrAt<20000?qr:null});
      }
      if(path===`/instance/inboxScope/${instance}`){
        if(req.method==='GET')return json(res,200,inboxScope());
        if(req.method==='PUT'){
          closeSelfReply();
          const previousConsent=scopeChanging?scopeBaseline:inboxMode==='all_private_text'&&inboxAccountValid()?{account:inboxAccount,at:inboxConsentedAt,includeSelfTests,selfTestConsentedAt}:null;
          if(!scopeChanging)scopeBaseline=previousConsent;
          scopeChanging++;let committedGeneration=null;
          // A failed or revoked reconfiguration closes both the broad receive
          // grant and the sender before awaiting request body or provider state.
          inboxMode='test';inboxAccount=null;inboxConsentedAt=null;includeSelfTests=false;selfTestConsentedAt=null;const changeGeneration=++inboxGeneration;mappingGeneration++;sendEnabled=false;inboxReplyEnabled=false;
          try{
          setConfig('inbox_scope',{mode:'test',consentedAt:null,account:null});
          const input=await body(req);
          if(changeGeneration!==inboxGeneration)throw fail('收件範圍在核對期間已改變，請重新讀取。',409);
          if(!['test','all_private_text'].includes(input.mode)||input.consent!==true)throw fail('請明確確認只接收新私人文字訊息的範圍。',409);
          if((input.replyToReceived!==undefined&&typeof input.replyToReceived!=='boolean')||(input.replyToReceived===true&&input.mode!=='all_private_text'))throw fail('請分別確認收件範圍及只回覆最近來訊的授權。',409);
          if((input.includeSelfTests!==undefined&&typeof input.includeSelfTests!=='boolean')||(input.includeSelfTests===true&&input.mode!=='all_private_text'))throw fail('自己傳給自己的訊息只可在已核對帳戶的收件箱明確開啟顯示測試。',409);
          if(input.mode==='all_private_text'&&(stopped||state!=='open'||!webhookEnabled))throw fail('請先確認手機已連接及收件網址已核對，才開放所有新私人文字來訊。',409);
          const account=input.mode==='all_private_text'?resolveLinkedPhone(socket,linkedAuthState,normalizeJid):null;
          if(input.mode==='all_private_text'&&!account)throw fail('尚未核對已連結帳戶身份，不能開放此帳戶的收件箱。',409);
          if(input.mode!=='all_private_text'||!previousConsent||previousConsent.account!==account){scopeBaseline=null;purgeOutOfScope();}
          if(input.includeSelfTests!==true)purgeSelfTestCallbacks();
          inboxMode=input.mode;committedGeneration=++inboxGeneration;
          inboxAccount=account;inboxConsentedAt=inboxMode==='all_private_text'?(previousConsent?.account===account?previousConsent.at:now()):null;
          includeSelfTests=input.includeSelfTests===true;
          selfTestConsentedAt=includeSelfTests?(previousConsent?.account===account&&previousConsent.includeSelfTests===true?previousConsent.selfTestConsentedAt:now()):null;
          setConfig('inbox_scope',{mode:inboxMode,consentedAt:inboxConsentedAt,account,includeSelfTests,selfTestConsentedAt});
          scopeBaseline=inboxMode==='all_private_text'?{account,at:inboxConsentedAt,includeSelfTests,selfTestConsentedAt}:null;
          inboxReplyEnabled=input.replyToReceived===true;
          return json(res,200,inboxScope());
          }catch(error){
            if(inboxGeneration===changeGeneration||inboxGeneration===committedGeneration){inboxMode='test';inboxAccount=null;inboxConsentedAt=null;includeSelfTests=false;selfTestConsentedAt=null;scopeBaseline=null;sendEnabled=false;inboxReplyEnabled=false;setConfig('inbox_scope',{mode:'test',consentedAt:null,account:null});purgeOutOfScope();}
            throw error;
          }finally{scopeChanging--;if(!scopeChanging){scopeBaseline=null;purgeOutOfScope();}}
        }
      }
      if(path===`/instance/testRecipients/${instance}`){
        if(req.method==='GET')return json(res,200,status().testMode);
        if(req.method==='PUT'){
          closeSelfReply();
          // "Only these test phones" revokes broad reception as well as sending,
          // including malformed/failed writes and concurrent reconfiguration.
          sendEnabled=false;inboxReplyEnabled=false;inboxMode='test';inboxAccount=null;inboxConsentedAt=null;includeSelfTests=false;selfTestConsentedAt=null;scopeBaseline=null;mappingGeneration++;inboxGeneration++;
          setConfig('inbox_scope',{mode:'test',consentedAt:null,account:null});purgeOutOfScope();
          if(testChanging)throw fail('正在核對測試範圍，請稍候。',409);testChanging=true;
          try{
            const input=await body(req),numbers=validateNumbers(input.numbers),activationEpoch=epoch,activationSocket=socket;
            if(input.consent!==true)throw fail('請先確認只使用本人指定的測試號碼。',409);
            if(input.activateSending===true&&(!allowTestActivation||state!=='open'||!webhookEnabled||!numbers.length))throw fail('手機連線、收件設定及測試號碼未齊全，尚未開啟發送。',409);
            if(state==='open'&&numbers.length){
              const linkedPhone=resolveLinkedPhone(socket,linkedAuthState,normalizeJid);
              if(!linkedPhone)throw fail('尚未確認已連結帳戶的電話身份，尚未開啟測試發送。',409);
              if(numbers.includes(linkedPhone))throw Object.assign(fail('這是剛連結的 WhatsApp 號碼。請填另一個已同意參與測試的 WhatsApp 號碼，並由該帳戶傳訊息過來。',409),{code:'SELF_TEST_RECIPIENT'});
            }
            if(state==='open'&&numbers.length)await prepareMappings(numbers);
            if(input.activateSending===true&&(stopped||state!=='open'||epoch!==activationEpoch||socket!==activationSocket))throw fail('連線在核對期間有變，尚未開啟發送，請重新檢查手機。',409);
            recipients=numbers;inboxGeneration++;setConfig('recipients',recipients);testConsentedAt=now();setConfig('test_consented_at',testConsentedAt);sendEnabled=input.activateSending===true;if(!numbers.length)mappingState='not_requested';purgeOutOfScope();
            return json(res,200,status().testMode);
          }finally{testChanging=false;}
        }
      }
      if(path===`/webhook/find/${instance}`&&req.method==='GET')return json(res,200,{webhook:expectedWebhook?{...expectedWebhook,enabled:webhookEnabled}:null});
      if(path===`/webhook/set/${instance}`&&req.method==='POST'){
        const input=await body(req),candidate=input.webhook;
        if(!expectedWebhook||!object(candidate)||candidate.enabled!==true||candidate.url!==expectedWebhook.url||candidate.byEvents!==false||candidate.base64!==false||!equal(candidate.headers?.Authorization,expectedWebhook.headers.Authorization)||!Array.isArray(candidate.events)||!expectedWebhook.events.every(event=>candidate.events.includes(event)))throw fail('只容許伺服器預先指定的本機收件網址及驗證。',409);
        webhookEnabled=true;setConfig('webhook_enabled',true);return json(res,200,{webhook:expectedWebhook});
      }
      if(path===`/message/sendText/${instance}`&&req.method==='POST'){
        const input=await body(req),number=input.number,text=input.text;
        if(typeof number!=='string'||!phonePattern.test(number))throw fail('此號碼不在已授權的回覆範圍。',403);
        if(resolveLinkedPhone(socket,linkedAuthState,normalizeJid)===number)throw fail('自己傳給自己的訊息只供顯示測試，不會由客服自動發送。',403);
        const address=number+'@s.whatsapp.net',testRecipient=recipients.includes(number),receivedReply=canReplyTo(address);
        if(!testRecipient&&!receivedReply)throw fail('此號碼不在指定測試名單，亦未有已授權的最近私人來訊。',403);
        if(((!sendEnabled||!testRecipient)&&!receivedReply)||state!=='open'||!socket)throw fail('WhatsApp 發送未開啟，或手機未連接。',409);
        if(typeof text!=='string'||!text.trim()||text.length>4000||input.linkPreview!==false)throw fail('只支援最多 4000 字的純文字測試。');
        if(now()-sendWindow>=60000){sendWindow=now();sendsThisMinute=0;}if(sendsThisMinute>=20)throw fail('測試訊息太頻密，請稍後再試。',429);sendsThisMinute++;
        const id=makeMessageId();
        db.prepare('INSERT INTO local_sends VALUES (?,?,?,?)').run(id,address,'sending',now());
        try{const result=await socket.sendMessage(address,{text:text.trim(),linkPreview:null},{messageId:id});if(typeof result?.key?.id!=='string'||!result.key.id)throw Error();db.prepare('UPDATE local_sends SET state=? WHERE id=?').run('accepted',id);return json(res,201,{key:{id:result.key.id},status:'accepted'});}catch{db.prepare('UPDATE local_sends SET state=? WHERE id=?').run('uncertain',id);throw fail('發送結果未確認，請先在 WhatsApp 核對，勿直接重發。',502);}
      }
      if(path===`/message/sendSelfTest/${instance}`&&req.method==='POST'){
        const input=await body(req);
        if(Object.keys(input).some(key=>!['text','grantId','replyToId','operationId','linkPreview'].includes(key))||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||input.linkPreview!==false||typeof input.grantId!=='string'||typeof input.replyToId!=='string'||!input.replyToId||input.replyToId.length>300||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.operationId))throw fail('本人回覆測試參數無效。');
        if(scopeChanging||!selfReplyValid()||input.grantId!==selfReply.grantId)throw fail('本人回覆測試尚未授權，或授權已失效。',403);
        const grant=selfReply,ownAddress=grant.account+'@s.whatsapp.net',text=input.text.trim();
        const observed=db.prepare('SELECT * FROM self_test_inputs WHERE request_id=? AND account=? AND address=?').get(input.replyToId,grant.account,ownAddress);
        if(!observed||observed.grant_id!==grant.grantId||observed.observed_at<grant.at||observed.timestamp<Math.floor(grant.at/1000)*1000||now()<observed.timestamp||now()-observed.timestamp>=86400000)throw fail('只可回覆這次授權後實際收到、仍在期限內的本人新文字。',403);
        const textHash=createHash('sha256').update(text).digest('hex');
        const previous=db.prepare('SELECT * FROM self_test_operations WHERE operation_id=?').get(input.operationId);
        if(previous){
          if(previous.account!==grant.account||previous.address!==ownAddress||previous.grant_id!==grant.grantId||previous.request_id!==input.replyToId||previous.text_hash!==textHash)throw fail('這個發送識別已用於另一項回覆，不能覆寫或重送。',409);
          if(previous.state==='accepted'&&previous.provider_id)return json(res,201,{key:{id:previous.provider_id},status:'accepted',duplicate:true,selfTest:true});
          throw fail('這項發送正在處理或結果未確認，請先在 WhatsApp 核對，勿重新發送。',409);
        }
        if(selfInFlight&&selfInFlight.epoch===epoch)throw fail('本人測試正在發送，請稍後。',409);
        if(now()-selfSendWindow>=60000){selfSendWindow=now();selfSendsThisMinute=0;}if(selfSendsThisMinute>=5){closeSelfReply();throw fail('本人測試每分鐘最多五次發送，授權已關閉，請稍後重新核對。',429);}
        const id=makeMessageId(),flight={epoch},sendSocket=socket;
        db.exec('BEGIN IMMEDIATE');
        try{db.prepare('INSERT INTO local_sends VALUES (?,?,?,?)').run(id,ownAddress,'sending',now());db.prepare('INSERT INTO self_test_operations VALUES (?,?,?,?,?,?,?,?,?,?)').run(input.operationId,grant.account,ownAddress,grant.grantId,input.replyToId,textHash,'sending',id,null,now());db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
        selfSendsThisMinute++;selfInFlight=flight;
        let timeout,late=false,success=false,network;
        const rememberAlias=result=>{
          const actual=result?.key?.id;
          if(typeof actual!=='string'||!actual||actual.length>300)throw Error('invalid_provider_id');
          const known=findLocalSend(actual);if(known&&known.id!==id)throw Error('provider_id_conflict');
          if(actual!==id)db.prepare('INSERT INTO local_send_aliases VALUES (?,?,?)').run(actual,id,ownAddress);
          return actual;
        };
        try{
          network=Promise.resolve(sendSocket.sendMessage(ownAddress,{text,linkPreview:null},{messageId:id}));
          const result=await Promise.race([network,new Promise((resolve,reject)=>{timeout=setTimeout(()=>{late=true;reject(Error('self_send_timeout'));},10000);})]);
          const actual=rememberAlias(result);
          db.prepare("UPDATE local_sends SET state='accepted' WHERE id=?").run(id);
          db.prepare("UPDATE self_test_operations SET state='accepted',provider_id=? WHERE operation_id=?").run(actual,input.operationId);
          success=true;return json(res,201,{key:{id:actual},status:'accepted',selfTest:true});
        }catch{
          if(selfReply?.grantId===grant.grantId)closeSelfReply();db.prepare("UPDATE local_sends SET state='uncertain' WHERE id=?").run(id);db.prepare("UPDATE self_test_operations SET state='uncertain' WHERE operation_id=?").run(input.operationId);
          if(late&&network){network.then(result=>{if(!stopped)try{rememberAlias(result);}catch{}}).catch(()=>{}).finally(()=>{if(selfInFlight===flight){selfInFlight=false;if(!stopped)drainSelfHeld(true);}});}
          throw fail('本人測試發送結果未確認，授權已關閉。請先在 WhatsApp 核對，勿直接重發。',502);
        }finally{clearTimeout(timeout);if(!late&&selfInFlight===flight){selfInFlight=false;drainSelfHeld(!success);}}
      }
      throw fail('找不到此操作。',404);
    } catch(error){if(!res.headersSent)json(res,Number.isInteger(error.status)?error.status:500,{error:Number.isInteger(error.status)?error.message:'本機 WhatsApp 接駁暫時未能完成。',...(error.code==='SELF_TEST_RECIPIENT'?{code:'SELF_TEST_RECIPIENT'}:{})});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,status,flush,async close(){if(stopped)return;closeSelfReply();stopped=true;selfHeld=[];epoch++;clearInterval(timer);clearTimeout(retryTimer);socket?.end(new Error('local_service_shutdown'));await saveChain;while(flushBusy)await new Promise(resolve=>setTimeout(resolve,10));if(server.listening)await new Promise(resolve=>server.close(resolve));db.close();}};
}
