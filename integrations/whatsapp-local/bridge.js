import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
const normalizedUser = jid => typeof jid==='string'?jid.replace(/^(\d+):\d+@(s\.whatsapp\.net|lid)$/,'$1@$2'):'';

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
export function createLocalBridge({ dataDir, instance='bluesai-local', apiKey, webhookUrl='', webhookSecret='', deliveryEnabled=false, allowTestActivation=false, testRecipients=[], makeSocket, loadAuth, encodeQr, logger, fetchImpl=fetch, now=Date.now, qrWaitMs=10000, normalizeJid=normalizedUser, makeMessageId=()=>randomUUID().replaceAll('-','').toUpperCase() }={}) {
  if(typeof apiKey!=='string'||apiKey.length<32)throw new Error('WA_LOCAL_API_KEY_TOO_SHORT');
  if(typeof instance!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(instance))throw new Error('INVALID_LOCAL_INSTANCE');
  if([makeSocket,loadAuth,encodeQr].some(fn=>typeof fn!=='function'))throw new Error('REAL_PROVIDER_FACTORY_REQUIRED');
  dataDir=validateDataDirectory(dataDir);mkdirSync(dataDir,{recursive:true,mode:0o700});
  const expectedWebhook=callbackConfig(webhookUrl,webhookSecret);
  const db=new DatabaseSync(resolve(dataDir,'bridge.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS bridge_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS callback_outbox(id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS local_sends(id TEXT PRIMARY KEY,address TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  const config=key=>{const r=db.prepare('SELECT value FROM bridge_config WHERE key=?').get(key);return r?JSON.parse(r.value):null;};
  const setConfig=(key,value)=>db.prepare('INSERT INTO bridge_config VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  const identity={instance,callback:webhookUrl||''};
  const previous=config('identity');
  if(previous && JSON.stringify(previous)!==JSON.stringify(identity)){db.close();throw new Error('LOCAL_BRIDGE_IDENTITY_CHANGED_USE_NEW_DATA_DIRECTORY');}
  if(!previous)setConfig('identity',identity);
  let recipients=validateNumbers(config('recipients')??testRecipients), sendEnabled=deliveryEnabled===true;
  if(!config('recipients'))setConfig('recipients',recipients);
  let webhookEnabled=Boolean(expectedWebhook&&config('webhook_enabled'));
  let state='close',socket=null,linkedAuthState=null,opening=null,stopped=false,epoch=0,qr=null,qrAt=0,lastReason='',retryTimer=null,flushBusy=false,saveChain=Promise.resolve();
  let ignored=0,reconnectAttempt=0,sendsThisMinute=0,sendWindow=now(),mappingState='not_requested',mappingGeneration=0,testChanging=false;
  const status=()=>({instance:{instanceName:instance,state},provider:'baileys-local',qrAvailable:Boolean(qr&&now()-qrAt<20000),lastReason,testMode:{count:recipients.length,maskedNumbers:recipients.map(number=>'••••'+number.slice(-4)),deliveryEnabled:sendEnabled,activationAvailable:allowTestActivation,mappingState},webhook:{configured:Boolean(expectedWebhook),enabled:webhookEnabled,pending:db.prepare('SELECT count(*) AS n FROM callback_outbox').get().n},ignoredOutsideTestScope:ignored});
  const scoped=address=>recipients.includes(address.split('@')[0]);
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
    const stored=knownSend&&typeof key?.id==='string'?db.prepare('SELECT address FROM local_sends WHERE id=?').get(key.id):null;
    if(direct)return stored&&stored.address!==direct?null:direct;
    if(typeof key?.remoteJid!=='string'||!/^\d+@lid$/.test(normalizeJid(key.remoteJid)))return null;
    // Direct delivery receipts may omit remoteJidAlt. A known random outgoing ID
    // is bound to the address saved before dispatch; it is not a suffix guess.
    if(stored)return stored.address;
    const lookup=socket?.signalRepository?.lidMapping?.getPNForLID;
    if(typeof lookup!=='function')return null;
    try{const mapped=normalizeJid(await lookup.call(socket.signalRepository.lidMapping,normalizeJid(key.remoteJid)));return phoneJid.test(mapped)?mapped:null;}catch{return null;}
  }
  function queue(event,eventKey,data) {
    const payload={event,instance,data};
    db.prepare('INSERT OR IGNORE INTO callback_outbox(id,event_key,payload,next_at,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),eventKey,JSON.stringify(payload),now(),now());
  }
  async function flush() {
    if(stopped||flushBusy||!webhookEnabled||!expectedWebhook)return;
    flushBusy=true;
    try {
      const row=db.prepare('SELECT * FROM callback_outbox WHERE next_at<=? ORDER BY created_at LIMIT 1').get(now());
      if(!row)return;
      // If the user removed a recipient, its queued text is no longer forwarded.
      const payload=JSON.parse(row.payload),address=payload.data?.key?.remoteJid||payload.data?.remoteJid;
      if(!address||!scoped(address)){db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);return;}
      try {
        const response=await fetchImpl(expectedWebhook.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{...expectedWebhook.headers,'Content-Type':'application/json'},body:row.payload});
        if(!response.ok)throw Error();
        db.prepare('DELETE FROM callback_outbox WHERE id=?').run(row.id);
      } catch {
        db.prepare('UPDATE callback_outbox SET attempts=attempts+1,next_at=? WHERE id=?').run(now()+Math.min(60000,1000*2**Math.min(row.attempts,6)),row.id);
      }
    } finally {flushBusy=false;}
  }
  async function onMessages(event,expectedEpoch) {
    if(!event||event.type!=='notify'||event.requestId||!Array.isArray(event.messages))return;
    if(!recipients.length){ignored+=event.messages.length;return;}
    for(const message of event.messages){
      const address=await phoneAddress(message.key);
      if(stopped||expectedEpoch!==epoch)return;
      if(!address||!scoped(address)){ignored++;continue;}
      const id=message.key?.id;
      if(typeof id!=='string'||!id||id.length>300||typeof message.key.fromMe!=='boolean')continue;
      if(message.key.fromMe && db.prepare('SELECT id FROM local_sends WHERE id=?').get(id))continue;
      const seconds=Number(message.messageTimestamp);
      // No history, undated or old events are copied into the customer's backend.
      if(!Number.isFinite(seconds)||seconds*1000<now()-300000||seconds*1000>now()+60000)continue;
      const content=message.message?.conversation??message.message?.extendedTextMessage?.text;
      if(typeof content!=='string'||!content.trim()||content.length>4000){ignored++;continue;}
      queue('messages.upsert',`message:${id}`,{key:{id,remoteJid:address,fromMe:message.key.fromMe},messageTimestamp:seconds,message:{conversation:content},pushName:typeof message.pushName==='string'?message.pushName.slice(0,100):'WhatsApp 測試來訊'});
    }
  }
  async function onUpdates(updates,expectedEpoch) {
    if(!Array.isArray(updates))return;
    for(const item of updates){if(item.key?.fromMe!==true)continue;const address=await phoneAddress(item.key,{knownSend:true}),id=item.key?.id,status=statusNames[item.update?.status];if(stopped||expectedEpoch!==epoch)return;if(!address||!scoped(address)||typeof id!=='string'||!id||!status)continue;queue('messages.update',`receipt:${id}:${status}`,{keyId:id,remoteJid:address,fromMe:true,status});}
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
      const current=++epoch;state='connecting';lastReason='';
      const auth=await loadAuth(resolve(dataDir,'auth'));
      if(stopped||current!==epoch)throw fail('接駁服務已停止。',503);
      linkedAuthState=auth.state;
      const candidate=makeSocket({auth:auth.state,logger,markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>!phoneJid.test(normalizeJid(jid))&&!/^\d+@lid$/.test(normalizeJid(jid)),getMessage:async()=>undefined});
      socket=candidate;
      candidate.ev.on('creds.update',()=>{if(current!==epoch||stopped)return;saveChain=saveChain.then(()=>auth.saveCreds()).catch(()=>{if(current!==epoch||stopped)return;lastReason='credential_save_failed';state='close';sendEnabled=false;candidate.end(new Error('credential_save_failed'));});});
      candidate.ev.on('messages.upsert',event=>{if(current===epoch&&!stopped)onMessages(event,current).catch(()=>{lastReason='incoming_mapping_failed';});});
      candidate.ev.on('messages.update',event=>{if(current===epoch&&!stopped)onUpdates(event,current).catch(()=>{lastReason='receipt_mapping_failed';});});
      candidate.ev.on('message-receipt.update',event=>{if(current===epoch&&!stopped)onReceipt(event,current)?.catch(()=>{lastReason='receipt_mapping_failed';});});
      candidate.ev.on('connection.update',update=>{
        if(current!==epoch||stopped)return;
        if(typeof update.qr==='string'){
          const raw=update.qr;
          encodeQr(raw).then(image=>{if(current===epoch&&!stopped&&state==='connecting'){qr=image;qrAt=now();}}).catch(()=>{lastReason='qr_encoding_failed';});
        }
        if(update.connection==='open'){state='open';qr=null;qrAt=0;reconnectAttempt=0;if(recipients.length)prepareMappings(recipients).catch(error=>{if(error.stale||current!==epoch||stopped||state!=='open'||socket!==candidate)return;sendEnabled=false;lastReason='recipient_mapping_unresolved';});}
        if(update.connection==='close'){
          state='close';qr=null;qrAt=0;socket=null;sendEnabled=false;
          const code=update.lastDisconnect?.error?.output?.statusCode;
          lastReason=code===401?'logged_out':code===403?'account_not_available':'connection_closed';
          if([401,403].includes(code)){sendEnabled=false;return;}
          if(!stopped&&reconnectAttempt<5){const delay=code===515?500:Math.min(30000,1000*2**reconnectAttempt++);retryTimer=setTimeout(()=>connect().catch(()=>{lastReason='reconnect_failed';state='close';}),delay);retryTimer.unref();}
        }
      });
    })().catch(()=>{state='close';socket=null;lastReason='connection_start_failed';throw fail('WhatsApp 連線未能啟動，請核對網絡及已連結裝置。',502);}).finally(()=>{opening=null;});
    return opening;
  }
  const timer=setInterval(()=>flush().catch(()=>{lastReason='callback_storage_failed';}),1000);timer.unref();
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{status:'ok',provider:'baileys-local'});
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!equal(req.headers.apikey,apiKey))throw fail('未獲授權。',401);
      if(path===`/instance/connectionState/${instance}`&&req.method==='GET')return json(res,200,status());
      if(path===`/instance/connect/${instance}`&&req.method==='GET'){
        await connect();const until=Date.now()+qrWaitMs;
        while(state==='connecting'&&!(qr&&now()-qrAt<20000)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,100));
        return json(res,200,{...status(),base64:qr&&now()-qrAt<20000?qr:null});
      }
      if(path===`/instance/testRecipients/${instance}`){
        if(req.method==='GET')return json(res,200,status().testMode);
        if(req.method==='PUT'){
          if(testChanging)throw fail('正在核對測試範圍，請稍候。',409);testChanging=true;sendEnabled=false;mappingGeneration++;
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
            recipients=numbers;setConfig('recipients',recipients);sendEnabled=input.activateSending===true;if(!numbers.length)mappingState='not_requested';
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
        if(typeof number!=='string'||!phonePattern.test(number)||!recipients.includes(number))throw fail('此號碼不在本次測試名單。',403);
        if(!sendEnabled||state!=='open'||!socket)throw fail('WhatsApp 測試發送未開啟，或手機未連接。',409);
        if(typeof text!=='string'||!text.trim()||text.length>4000||input.linkPreview!==false)throw fail('只支援最多 4000 字的純文字測試。');
        if(now()-sendWindow>=60000){sendWindow=now();sendsThisMinute=0;}if(sendsThisMinute>=20)throw fail('測試訊息太頻密，請稍後再試。',429);sendsThisMinute++;
        const id=makeMessageId(),address=number+'@s.whatsapp.net';
        db.prepare('INSERT INTO local_sends VALUES (?,?,?,?)').run(id,address,'sending',now());
        try{const result=await socket.sendMessage(address,{text:text.trim(),linkPreview:null},{messageId:id});if(typeof result?.key?.id!=='string'||!result.key.id)throw Error();db.prepare('UPDATE local_sends SET state=? WHERE id=?').run('accepted',id);return json(res,201,{key:{id:result.key.id},status:'accepted'});}catch{db.prepare('UPDATE local_sends SET state=? WHERE id=?').run('uncertain',id);throw fail('發送結果未確認，請先在 WhatsApp 核對，勿直接重發。',502);}
      }
      throw fail('找不到此操作。',404);
    } catch(error){if(!res.headersSent)json(res,Number.isInteger(error.status)?error.status:500,{error:Number.isInteger(error.status)?error.message:'本機 WhatsApp 接駁暫時未能完成。',...(error.code==='SELF_TEST_RECIPIENT'?{code:'SELF_TEST_RECIPIENT'}:{})});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,status,flush,async close(){if(stopped)return;stopped=true;epoch++;clearInterval(timer);clearTimeout(retryTimer);socket?.end(new Error('local_service_shutdown'));await saveChain;while(flushBusy)await new Promise(resolve=>setTimeout(resolve,10));if(server.listening)await new Promise(resolve=>server.close(resolve));db.close();}};
}
