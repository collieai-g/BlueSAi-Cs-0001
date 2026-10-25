import { createAgent } from './agent.js';
import { createEvolution } from './evolution.js';
import { ServiceError } from './engine.js';

// Secrets stay in server memory/environment, never in status or the database.
export function createConnections({ engine, store, fetchImpl = fetch, runtime = false, providerConfig = {}, aiConfig = {}, publicBaseUrl = '', webhookSecret = '' }) {
  let ai = { status: engine.agent.configured ? 'configured' : 'unconfigured', model: aiConfig.model || '' };
  let waSecret = runtime && providerConfig.url && providerConfig.instance && providerConfig.apiKey
    ? { url: providerConfig.url.replace(/\/$/, ''), instance: providerConfig.instance, apiKey: providerConfig.apiKey } : null;
  let wa = waSecret ? { status: 'configured', url: waSecret.url, instance: waSecret.instance } : { status: 'unconfigured' };
  let changing = false, webhookRegistered = false, webhookCheckedAt = null;
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
    try {
      const response = await fetchImpl(`${waSecret.url}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: waSecret.apiKey, ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      wa.status = 'error';
      throw new ServiceError('連線未成功。請檢查服務網址、連線名稱及金鑰，並確認 Evolution 正在運行。', 502);
    }
  }
  const instancePath = action => `/instance/${action}/${encodeURIComponent(waSecret?.instance || '')}`;
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
      return { mode: runtime ? 'runtime' : 'preview', runtimeName: runtime ? '客服收發執行器' : '隔離本機預覽', publicBaseUrl: callbackUrl ? new URL(callbackUrl).origin : '', ai: { ...ai }, whatsapp: {
        ...wa, receiveEnabled: Boolean(runtime && engine.evolution.configured && webhookSecret), deliveryEnabled: Boolean(runtime && engine.evolution.deliveryEnabled),
        webhook: { configured: webhookConfigured(), registered: webhookRegistered, verifiedAt: webhookCheckedAt },
        evidence: { lastIncomingAt: activity?.last_incoming_at || null, lastReceiptAt: activity?.last_receipt_at || null },
      } };
    },
    model: input => exclusive(async () => {
      const model = text(input.model || aiConfig.model, 100), apiKey = text(input.apiKey || aiConfig.apiKey, 500);
      const candidate = createAgent({ model, apiKey, fetchImpl });
      try { await candidate.reply({ profile: { tone: 'friendly' }, facts: [], history: [{ role: 'user', content: '你好，我想了解服務。' }] }); }
      catch { throw new ServiceError('AI 測試未成功。請檢查金鑰、模型名稱及帳戶額度；模型需支援 Responses 與結構化回覆。', 502); }
      engine.agent = candidate; ai = { status: 'connected', model, checkedAt: Date.now() }; store.revise();
      return { message: 'AI 已通過實際回覆測試，可以到「訓練」教客服。' };
    }),
    clearAI: () => exclusive(async () => { engine.agent = createAgent(); ai = { status: 'unconfigured', model: '' }; store.revise(); }),
    whatsapp: (input = {}) => exclusive(async () => {
      if (runtime) {
        if (!providerConfig.url || !providerConfig.instance || !providerConfig.apiKey) throw new ServiceError('請先在伺服器秘密設定填寫 Evolution 網址、instance 及 API key，然後重啟。', 409);
        if ((input.url && input.url.replace(/\/$/, '') !== providerConfig.url.replace(/\/$/, '')) ||
            (input.instance && input.instance !== providerConfig.instance) || (input.apiKey && input.apiKey !== providerConfig.apiKey)) throw new ServiceError('收發執行器使用伺服器固定的渠道設定；更改渠道請更新伺服器秘密並重啟。', 409);
        waSecret = { url: providerConfig.url.replace(/\/$/, ''), instance: providerConfig.instance, apiKey: providerConfig.apiKey };
        engine.evolution = createEvolution({ ...providerConfig, fetchImpl });
      } else {
        const url = text(input.url, 500).replace(/\/$/, ''), instance = text(input.instance, 100);
        const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? text(input.apiKey, 500) : waSecret?.url === url && waSecret?.instance === instance ? waSecret.apiKey : '';
        if (!apiKey) throw new ServiceError('請填寫接駁金鑰。');
        try { createEvolution({ url, instance, apiKey }); } catch { throw new ServiceError('請使用有效的 HTTPS 服務網址。本機 localhost 可使用 HTTP。'); }
        waSecret = { url, instance, apiKey };
      }
      wa = { status: 'configured', url: waSecret.url, instance: waSecret.instance };
      const data = await request(instancePath('connect'));
      const qr = data.base64 || data.qrcode?.base64;
      const safeQr = typeof qr === 'string' && qr.length < 500000 && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(qr) ? qr : null;
      const status = data.instance?.state === 'open' ? 'open' : safeQr ? 'connecting' : 'unknown'; wa.status = status;
      return { qr: safeQr, status, message: status === 'open' ? runtime ? 'WhatsApp 裝置已連接；Webhook、發送開關及實際收發各自核對。' : 'WhatsApp 裝置已連接；本機仍未開啟訊息收發。' : safeQr ? '請在 WhatsApp 的「已連結裝置」掃描，完成後按「檢查連線」。' : '服務暫未提供二維碼。請檢查連線狀態，或重新取得二維碼。' };
    }),
    checkWhatsApp: () => exclusive(async () => {
      const data = await request(instancePath('connectionState'));
      const state = data.instance?.state; wa.status = ['open', 'close', 'connecting'].includes(state) ? state : 'unknown'; wa.checkedAt = Date.now();
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
    clearWhatsApp: () => exclusive(async () => {
      waSecret = null; wa = { status: 'unconfigured' }; webhookRegistered = false; webhookCheckedAt = null;
      if (runtime) { engine.evolution = createEvolution(); store.revise(); }
    }),
  };
}
