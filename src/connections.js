import { createAgent } from './agent.js';
import { createEvolution } from './evolution.js';
import { ServiceError } from './engine.js';
import { receiveDiagnostics } from './receive-diagnostics.js';

// A remembered native/cleared selection must never fall back to ambient API
// credentials on restart. Native CLI access needs a fresh explicit probe.
export function createRuntimeAgent(store, aiConfig = {}) {
  const selected=store.value('reply_provider');
  const allowed=selected.provider==='environment'||(selected.provider==='openai'&&selected.model===aiConfig.model);
  return createAgent(allowed?aiConfig:{});
}

// Secrets stay in server memory/environment, never in status or the database.
export function createConnections({ engine, store, fetchImpl = fetch, runtime = false, providerConfig = {}, aiConfig = {}, publicBaseUrl = '', webhookSecret = '', localWhatsAppTest = false, nativeAgentFactory = null }) {
  const selected=store.value('reply_provider');
  const requiresCheck=!engine.agent.configured&&['codex-cli','openai'].includes(selected.provider);
  let ai = { status: engine.agent.configured || (requiresCheck&&selected.provider==='codex-cli') ? 'configured' : 'unconfigured',
    model: requiresCheck ? (selected.model||'') : (aiConfig.model||engine.agent.model||''),
    provider:engine.agent.configured ? (engine.agent.provider||'openai') : requiresCheck ? selected.provider : 'none',requiresCheck };
  const closeAgent = async agent => { try { await agent?.close?.(); } catch { store.audit('reply_provider_close_failed'); } };
  let waSecret = runtime && providerConfig.url && providerConfig.instance && providerConfig.apiKey
    ? { url: providerConfig.url.replace(/\/$/, ''), instance: providerConfig.instance, apiKey: providerConfig.apiKey } : null;
  let wa = waSecret ? { status: 'configured', url: waSecret.url, instance: waSecret.instance } : { status: 'unconfigured' };
  let changing = false, webhookRegistered = false, webhookCheckedAt = null;
  let manualTestEnabled = false;
  let inboxReplyEnabled = false;
  let inboxScope = { available:localWhatsAppTest, mode:'test',consented:false,replyToReceived:false,includeSelfTests:false,supported:['new_private_text'],excluded:['history','groups','broadcasts','self_messages','media'],replyScope:'recent_incoming_only' };
  let testRecipients = { count: 0, maskedNumbers: [], deliveryEnabled: false, activationAvailable: false };
  if (localWhatsAppTest) {
    const target = waSecret && new URL(waSecret.url);
    if (!runtime || !target || target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/') throw new Error('LOCAL_WHATSAPP_TEST_REQUIRES_LOOPBACK_BRIDGE');
    // Local test consent belongs to this core process, even if a bridge is still
    // linked and a generic deployment environment has DELIVERY_ENABLED=true.
    engine.evolution = createEvolution({ ...providerConfig, deliveryEnabled:false, fetchImpl });
  }
  let callbackUrl = '';
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
        (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('INVALID_PUBLIC_BASE_URL');
    callbackUrl = `${parsed.origin}/webhooks/evolution`;
  }
  if (waSecret) {
    // A data directory represents one merchant/channel. A restart must not silently
    // send old conversations through a different provider account with similar JIDs.
    const identity = { url: waSecret.url, instance: waSecret.instance };
    const current = store.get("SELECT value FROM config WHERE key='runtime_provider_identity'");
    if (current && JSON.stringify(JSON.parse(current.value)) !== JSON.stringify(identity)) throw new Error('CHANNEL_IDENTITY_CHANGED_USE_SEPARATE_DATA_DIRECTORY');
    if (!current) store.run('INSERT INTO config VALUES (?,?)', 'runtime_provider_identity', JSON.stringify(identity));
  }
  const webhookConfigured = () => Boolean(runtime && callbackUrl && webhookSecret.length >= 32 && waSecret);
  async function exclusive(fn) {
    if (changing) throw new ServiceError('正在測試接駁，請稍候。', 409);
    changing = true;
    try { return await fn(); } finally { changing = false; }
  }
  const text = (x, max) => {
    if (typeof x !== 'string' || !x.trim() || x.length > max) throw new ServiceError('請填齊接駁資料。');
    return x.trim();
  };
  async function request(path, { method = 'GET', data } = {}) {
    if (!waSecret) throw new ServiceError(runtime ? '請先在伺服器秘密設定填寫 Evolution 網址、instance 及 API key，然後重啟。' : '請先填寫 Evolution 服務資料。');
    let recipientInputError;
    try {
      const response = await fetchImpl(`${waSecret.url}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: waSecret.apiKey, ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok) {
        if (localWhatsAppTest && method === 'PUT' && path === instancePath('testRecipients')) {
          const failure = await response.json().catch(()=>null);
          if (failure?.code === 'SELF_TEST_RECIPIENT') {
            recipientInputError = new ServiceError('這是剛連結的 WhatsApp 帳戶。請改填另一個已同意參與測試的 WhatsApp 號碼，再由該號碼傳訊息過來；自己傳給自己的訊息不會進入客服。',409);
            throw recipientInputError;
          }
        }
        throw new Error();
      }
      return await response.json();
    } catch (error) {
      if (recipientInputError && error === recipientInputError) throw error;
      wa.status = 'error';
      throw new ServiceError('連線未成功。請檢查服務網址、連線名稱及金鑰，並確認 Evolution 正在運行。', 502);
    }
  }
  const instancePath = action => `/instance/${action}/${encodeURIComponent(waSecret?.instance || '')}`;
  async function refreshTestRecipients() {
    if (!localWhatsAppTest) return;
    const data = await request(instancePath('testRecipients'));
    if (!Number.isInteger(data.count) || data.count < 0 || data.count > 3 || !Array.isArray(data.maskedNumbers) || data.maskedNumbers.length !== data.count) throw new ServiceError('測試號碼設定未能核對。',502);
    testRecipients = { count: data.count, maskedNumbers: data.maskedNumbers.map(value => '••••' + String(value).replace(/\D/g,'').slice(-4)), deliveryEnabled: data.deliveryEnabled === true, activationAvailable: data.activationAvailable === true };
    if (manualTestEnabled && (!testRecipients.deliveryEnabled || !testRecipients.count)) {
      manualTestEnabled = false;
      engine.evolution = createEvolution({ ...providerConfig, deliveryEnabled:false, fetchImpl });
      store.revise();
    }
  }
  async function refreshInboxScope() {
    if(!localWhatsAppTest)return {...inboxScope};
    const data=await request(instancePath('inboxScope'));
    if(!['test','all_private_text'].includes(data.mode)||typeof data.consented!=='boolean'||typeof data.replyToReceived!=='boolean')throw new ServiceError('收件範圍未能讀回核對，請更新本機接駁服務。',502);
    const includeSelfTests=data.mode==='all_private_text'&&data.consented===true&&data.includeSelfTests===true;
    inboxScope={...inboxScope,mode:data.mode,consented:data.consented,replyToReceived:data.replyToReceived,includeSelfTests,
      supported:includeSelfTests?['new_private_text','self_test_text']:['new_private_text'],excluded:['history','groups','broadcasts',...(!includeSelfTests?['self_messages']:[]),'media']};
    if(inboxReplyEnabled && (data.mode!=='all_private_text'||!data.consented||!data.replyToReceived)){
      inboxReplyEnabled=false;
      engine.evolution=createEvolution({...providerConfig,deliveryEnabled:manualTestEnabled,fetchImpl});store.revise();
    }
    return {...inboxScope};
  }
  async function checkWebhook() {
    if (!webhookConfigured()) throw new ServiceError('請先設定 PUBLIC_BASE_URL、WEBHOOK_SECRET 及 Evolution 伺服器秘密，然後重啟。', 409);
    webhookRegistered = false;
    const response = await request(`/webhook/find/${encodeURIComponent(waSecret.instance)}`);
    const config = response?.webhook || response;
    const auth = config?.headers && Object.entries(config.headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    webhookRegistered = Boolean(config?.enabled === true && config.url === callbackUrl && auth === `Bearer ${webhookSecret}` &&
      (config.webhookByEvents ?? config.byEvents) === false && (config.webhookBase64 ?? config.base64) === false &&
      Array.isArray(config.events) && ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'].every(event => config.events.includes(event)));
    webhookCheckedAt = Date.now();
    return { registered: webhookRegistered, verifiedAt: webhookCheckedAt, message: webhookRegistered
      ? 'Webhook 設定已在供應商讀回核對；仍需測試帳號實際來訊及收件驗收。' : 'Webhook 與本服務所需的網址、驗證或事件不符，請重新登記。' };
  }
  return {
    status: () => {
      const activity = waSecret ? store.get('SELECT * FROM channel_activity WHERE instance=?', waSecret.instance) : null;
      const profile = store.value('profile'), settings = store.value('settings');
      const missingFields = engine.inboxPolicy().enabled ? [] : [!profile.name && '商戶名稱', !profile.service && '服務說明', !settings.handoffContact && '人工接手方式'].filter(Boolean);
      let health={};
      if(engine.agent.provider==='codex-cli'&&typeof engine.agent.health==='function'){
        try{
          const current=engine.agent.health();
          if(['configured','connected','error'].includes(current?.status))health.status=current.status;
          if(Number.isFinite(current?.checkedAt)&&current.checkedAt>=0)health.checkedAt=current.checkedAt;
          if(typeof current?.lastError==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(current.lastError))health.lastError=current.lastError;
        }catch{health={status:'error',lastError:'NATIVE_HEALTH_UNAVAILABLE'};}
      }
      return { mode: runtime ? 'runtime' : 'preview', runtimeName: runtime ? '客服收發執行器' : '隔離本機預覽', publicBaseUrl: callbackUrl ? new URL(callbackUrl).origin : '', ai: { ...ai,...health,nativeAvailable:runtime&&typeof nativeAgentFactory==='function' }, whatsapp: {
        ...wa, receiveEnabled: Boolean(runtime && engine.evolution.configured && webhookSecret), deliveryEnabled: Boolean(runtime && engine.evolution.deliveryEnabled),
        webhook: { configured: webhookConfigured(), registered: webhookRegistered, verifiedAt: webhookCheckedAt },
        evidence: { lastIncomingAt: activity?.last_incoming_at || null, lastReceiptAt: activity?.last_receipt_at || null },
        localTest: localWhatsAppTest, manualTestEnabled, inboxReplyEnabled,inboxScope:{...inboxScope},testRecipients: { ...testRecipients }, readiness: { missingFields, canSend: missingFields.length === 0 && engine.liveReady() && wa.status === 'open' && webhookRegistered && (!localWhatsAppTest || manualTestEnabled || inboxReplyEnabled) },
      } };
    },
    model: input => exclusive(async () => {
      const model = text(input.model || aiConfig.model, 100), apiKey = text(input.apiKey || aiConfig.apiKey, 500);
      const candidate = createAgent({ model, apiKey, fetchImpl });
      try { await candidate.reply({ profile: { tone: 'friendly' }, facts: [], history: [{ role: 'user', content: '你好，我想了解服務。' }] }); }
      catch { throw new ServiceError('AI 測試未成功。請檢查金鑰、模型名稱及帳戶額度；模型需支援 Responses 與結構化回覆。', 502); }
      const previous=engine.replaceAgent(candidate,{provider:'openai',model});ai = { status: 'connected', provider:'openai', model, checkedAt: Date.now(),requiresCheck:false };
      await closeAgent(previous);
      return { message: 'AI 已通過實際回覆測試，可以到「訓練」教客服。' };
    }),
    nativeCodex: input => exclusive(async()=>{
      if(!runtime||typeof nativeAgentFactory!=='function')throw new ServiceError('這個服務未提供原生 Codex 自動處理。',409);
      if(!input||input.consent!==true||Object.keys(input).some(key=>key!=='consent'))throw new ServiceError('請確認同意由本機原生 Codex 處理授權的客服文字。');
      let candidate;
      try{
        candidate=await nativeAgentFactory();
        if(!candidate?.configured||candidate.provider!=='codex-cli'||typeof candidate.check!=='function'||typeof candidate.reply!=='function')throw new Error('INVALID_NATIVE_PROVIDER');
        await candidate.check();
      }catch{
        await closeAgent(candidate);
        throw new ServiceError('原生 Codex 測試未成功。請在本機核對 CLI、ChatGPT 登入及可用額度後再試；尚未開啟 AI 自動回覆。',502);
      }
      let previous;
      try{previous=engine.replaceAgent(candidate);}catch(error){await closeAgent(candidate);throw error;}
      ai={status:'connected',provider:'codex-cli',model:'account_default',checkedAt:Date.now(),requiresCheck:false};
      await closeAgent(previous);
      return {message:'原生 Codex 已通過登入及實際回覆測試。AI 後備與自動發送須另外啟用。',provider:'codex-cli'};
    }),
    clearAI: () => exclusive(async () => {
      const policy=engine.inboxPolicy();
      if(policy.aiFallback||policy.automaticAi)engine.configureInbox({...policy,aiFallback:false,automaticAi:false});
      const previous=engine.replaceAgent(createAgent());ai = { status: 'unconfigured', provider:'none', model: '',requiresCheck:false };
      await closeAgent(previous);
    }),
    whatsapp: (input = {}) => exclusive(async () => {
      if (runtime) {
        if (!providerConfig.url || !providerConfig.instance || !providerConfig.apiKey) throw new ServiceError('請先在伺服器秘密設定填寫 Evolution 網址、instance 及 API key，然後重啟。', 409);
        if ((input.url && input.url.replace(/\/$/, '') !== providerConfig.url.replace(/\/$/, '')) ||
            (input.instance && input.instance !== providerConfig.instance) || (input.apiKey && input.apiKey !== providerConfig.apiKey)) throw new ServiceError('收發執行器使用伺服器固定的渠道設定；更改渠道請更新伺服器秘密並重啟。', 409);
        waSecret = { url: providerConfig.url.replace(/\/$/, ''), instance: providerConfig.instance, apiKey: providerConfig.apiKey };
        engine.evolution = createEvolution({ ...providerConfig, deliveryEnabled: localWhatsAppTest ? (manualTestEnabled || inboxReplyEnabled) : providerConfig.deliveryEnabled, fetchImpl });
      } else {
        const url = text(input.url, 500).replace(/\/$/, ''), instance = text(input.instance, 100);
        const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? text(input.apiKey, 500) : waSecret?.url === url && waSecret?.instance === instance ? waSecret.apiKey : '';
        if (!apiKey) throw new ServiceError('請填寫接駁金鑰。');
        try { createEvolution({ url, instance, apiKey }); } catch { throw new ServiceError('請使用有效的 HTTPS 服務網址。本機 localhost 可使用 HTTP。'); }
        waSecret = { url, instance, apiKey };
      }
      wa = { status: 'configured', url: waSecret.url, instance: waSecret.instance };
      const data = await request(instancePath('connect'));
      if (localWhatsAppTest) wa.receiveDiagnostics = receiveDiagnostics(data.receiveDiagnostics);
      if (localWhatsAppTest) await refreshTestRecipients();
      const qr = data.base64 || data.qrcode?.base64;
      const safeQr = typeof qr === 'string' && qr.length < 500000 && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(qr) ? qr : null;
      const status = data.instance?.state === 'open' ? 'open' : safeQr ? 'connecting' : 'unknown'; wa.status = status;
      return { qr: safeQr, status, message: status === 'open' ? runtime ? 'WhatsApp 裝置已連接；Webhook、發送開關及實際收發各自核對。' : 'WhatsApp 裝置已連接；本機仍未開啟訊息收發。' : safeQr ? '請在 WhatsApp 的「已連結裝置」掃描，完成後按「檢查連線」。' : '服務暫未提供二維碼。請檢查連線狀態，或重新取得二維碼。' };
    }),
    checkWhatsApp: () => exclusive(async () => {
      const data = await request(instancePath('connectionState'));
      if (localWhatsAppTest) wa.receiveDiagnostics = receiveDiagnostics(data.receiveDiagnostics);
      const state = data.instance?.state; wa.status = ['open', 'close', 'connecting'].includes(state) ? state : 'unknown'; wa.checkedAt = Date.now();
      if (localWhatsAppTest) await refreshTestRecipients();
      return { status: wa.status, message: wa.status === 'open' ? runtime ? 'WhatsApp 裝置已連接；尚須核對 Webhook 及指定測試帳號收發。' : 'WhatsApp 裝置已連接；本機仍未開啟訊息收發。' : wa.status === 'close' ? '手機尚未連接，請重新取得二維碼。' : wa.status === 'connecting' ? '正在等待手機連接，請完成掃碼後再檢查。' : '服務未回傳可確認的狀態。' };
    }),
    registerWebhook: () => exclusive(async () => {
      if (!webhookConfigured()) throw new ServiceError('請先設定 PUBLIC_BASE_URL、WEBHOOK_SECRET 及 Evolution 伺服器秘密，然後重啟。', 409);
      webhookRegistered = false;
      await request(`/webhook/set/${encodeURIComponent(waSecret.instance)}`, { method: 'POST', data: { webhook: {
        enabled: true, url: callbackUrl, headers: { Authorization: `Bearer ${webhookSecret}` }, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
      } } });
      return checkWebhook();
    }),
    checkWebhook: () => exclusive(checkWebhook),
    getInboxScope:()=>exclusive(refreshInboxScope),
    configureInboxScope:input=>exclusive(async()=>{
      if(!localWhatsAppTest||!runtime||!waSecret)throw new ServiceError('這個服務未提供本機即時收件範圍設定。',409);
      manualTestEnabled=false;inboxReplyEnabled=false;
      engine.evolution=createEvolution({...providerConfig,deliveryEnabled:false,fetchImpl});store.revise();
      const includeSelfTests=input?.includeSelfTests===true;
      if(!input||!['test','all_private_text'].includes(input.mode)||input.consent!==true||typeof input.replyToReceived!=='boolean'||(input.includeSelfTests!==undefined&&typeof input.includeSelfTests!=='boolean')||(input.mode==='test'&&(input.replyToReceived||includeSelfTests)))throw new ServiceError('請確認收件範圍、最近來訊回覆及自身文字測試。');
      if((await request(instancePath('connectionState'))).instance?.state!=='open')throw new ServiceError('請先核對 WhatsApp 手機連線。',409);
      wa.status='open';wa.checkedAt=Date.now();
      if(!(await checkWebhook()).registered)throw new ServiceError('請先設定並核對收件網址。',409);
      await request(instancePath('inboxScope'),{method:'PUT',data:{mode:input.mode,consent:true,replyToReceived:input.replyToReceived,includeSelfTests}});
      const result=await refreshInboxScope();
      if(result.mode!==input.mode||!result.consented||result.replyToReceived!==input.replyToReceived||result.includeSelfTests!==includeSelfTests)throw new ServiceError('收件、回覆或自身測試範圍讀回不相符，尚未開啟客服發送。',502);
      const provider=createEvolution({...providerConfig,deliveryEnabled:input.replyToReceived,fetchImpl});
      store.transaction(()=>{store.revise();store.audit('whatsapp_inbox_scope_updated',input.mode+(includeSelfTests?';self_test:on':''));});
      engine.evolution=provider;inboxReplyEnabled=input.replyToReceived;
      return {...result,message:(input.replyToReceived?'已接收新私人文字來訊，並允許回覆最近 24 小時實際傳訊過來的客戶。知識庫自動回覆仍依卡片開關及已確認答案。':'收件範圍已更新；發送保持關閉。')+(includeSelfTests?' 自己傳給自己的新文字會另列為只讀連線測試，不會自動回覆。':'')};
    }),
    configureTestRecipient: input => exclusive(async () => {
      if (!localWhatsAppTest || !runtime || !waSecret) throw new ServiceError('這個接駁服務未提供受限本機 WhatsApp 測試。',409);
      // Reconfiguration first closes the sender, including failed readiness
      // checks and unknown provider writes from a previously active session.
      manualTestEnabled = false;
      inboxReplyEnabled = false;
      engine.evolution = createEvolution({ ...providerConfig, deliveryEnabled:false, fetchImpl });
      store.revise();
      if (input?.consent !== true || typeof input.number !== 'string') throw new ServiceError('請填寫測試號碼並確認已獲同意。');
      const number = input.number.replace(/[\s+()-]/g,'');
      if (!/^[1-9]\d{7,14}$/.test(number)) throw new ServiceError('請填寫含國碼的測試電話號碼（8 至 15 位數字）。');
      const state = await request(instancePath('connectionState'));
      if (state.instance?.state !== 'open') throw new ServiceError('請先用手機掃碼，並按「檢查連線」核對。',409);
      wa.status = 'open'; wa.checkedAt = Date.now();
      if (!(await checkWebhook()).registered) throw new ServiceError('請先設定並核對收件網址。',409);
      await request(instancePath('testRecipients'),{method:'PUT',data:{numbers:[number],activateSending:true,consent:true}});
      await refreshTestRecipients();
      await refreshInboxScope();
      if (!testRecipients.deliveryEnabled || testRecipients.count !== 1 || !testRecipients.maskedNumbers[0].endsWith(number.slice(-4))) throw new ServiceError('測試號碼或發送開關未能讀回核對，尚未啟用客服發送。',502);
      if(inboxScope.mode!=='test'||inboxScope.replyToReceived)throw new ServiceError('指定號碼模式未能讀回核對，尚未啟用發送。',502);
      const approvedProvider = createEvolution({ ...providerConfig, deliveryEnabled:true, fetchImpl });
      store.transaction(()=>{store.set('settings',{...store.value('settings'),mode:'review'});store.revise();store.audit('whatsapp_manual_test_enabled',waSecret.instance);});
      engine.evolution = approvedProvider;
      manualTestEnabled = true;
      return { enabled:true, testRecipients:{...testRecipients}, message:'已只開放這個測試號碼，回覆須由你在卡片內核對後發送。尚未填齊商戶名稱、服務及人工接手方式時，請先補齊基本設定。' };
    }),
    clearWhatsApp: () => exclusive(async () => {
      // Close the core sender before waiting on a slow or unavailable bridge.
      manualTestEnabled = false;
      inboxReplyEnabled = false;
      inboxScope={...inboxScope,mode:'test',consented:false,replyToReceived:false,includeSelfTests:false,supported:['new_private_text'],excluded:['history','groups','broadcasts','self_messages','media']};
      if (runtime) { engine.evolution = createEvolution(); store.revise(); }
      if (localWhatsAppTest && waSecret) {
        try { await request(instancePath('inboxScope'),{method:'PUT',data:{mode:'test',replyToReceived:false,consent:true}}); } catch {}
        try { await request(instancePath('testRecipients'),{method:'PUT',data:{numbers:[],activateSending:false,consent:true}}); } catch {}
      }
      manualTestEnabled = false; testRecipients = { count:0,maskedNumbers:[],deliveryEnabled:false,activationAvailable:localWhatsAppTest };
      waSecret = null; wa = { status: 'unconfigured' }; webhookRegistered = false; webhookCheckedAt = null;
    }),
  };
}
