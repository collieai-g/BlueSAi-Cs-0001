import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ServiceError } from './engine.js';
import { normalizeEvent } from './evolution.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const string = (value, max = 4000, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ServiceError('請填寫有效內容。');
  return value.trim();
};
const choice = (value, choices) => { if (!choices.includes(value)) throw new ServiceError('設定值不正確。'); return value; };
async function body(req) {
  let size = 0; const chunks = [];
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ServiceError('需要 JSON 格式。', 415);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new ServiceError('內容太長。', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new ServiceError('JSON 內容不正確。'); }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }

export function createApp({ store, engine, adminToken, webhookSecret = '', cookieSecure = false, activationAt = Date.now() }) {
  if (adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters');
  if (webhookSecret && webhookSecret.length < 32) throw new Error('WEBHOOK_SECRET must contain at least 32 characters');
  const sessions = new Map(); const failures = new Map();
  const cookie = (value, age) => `bp_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${cookieSecure ? '; Secure' : ''}`;
  const runtime = () => ({ agent: engine.agent.configured ? 'openai' : 'offline', evolutionConfigured: engine.evolution.configured,
    deliveryEnabled: engine.evolution.deliveryEnabled, liveReady: engine.liveReady(), webhookConfigured: Boolean(webhookSecret) });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (path === '/healthz' && method === 'GET') return json(res, 200, { status: 'ok' });
      if (path === '/webhooks/evolution' && method === 'POST') {
        if (!webhookSecret || !engine.evolution.instance || !equal(req.headers.authorization, `Bearer ${webhookSecret}`)) throw new ServiceError('未獲授權。', 401);
        const payload = await body(req);
        let event;
        try { event = normalizeEvent(payload, engine.evolution.instance); }
        catch { throw new ServiceError('訊息事件無效。'); }
        if (event.kind === 'ignore') return json(res, 200, { ignored: event.reason });
        if (event.kind === 'outgoing') { engine.outgoingEcho(event); return json(res, 200, { received: true }); }
        const result = engine.receive({ channel: 'evolution', ...event, review: event.review || event.timestamp < activationAt });
        return json(res, 200, { received: true, duplicate: result.duplicate });
      }
      if (path === '/api/login' && method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new ServiceError('來源不符。', 403);
        const ip = req.socket.remoteAddress || '';
        const now = Date.now();
        for (const [key, value] of failures) if (value.until < now) failures.delete(key);
        if ((failures.get(ip)?.count || 0) >= 10) throw new ServiceError('登入嘗試太多，請十五分鐘後再試。', 429);
        const input = await body(req);
        if (!equal(input.token, adminToken)) {
          const old = failures.get(ip); failures.set(ip, { count: (old?.count || 0) + 1, until: now + 900000 });
          throw new ServiceError('管理員密碼不正確。', 401);
        }
        failures.delete(ip);
        for (const [id, expiry] of sessions) if (expiry < now) sessions.delete(id);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const id = randomBytes(32).toString('hex'); sessions.set(id, now + 12 * 3600000);
        res.setHeader('Set-Cookie', cookie(id, 12 * 3600)); return json(res, 200, { ok: true });
      }
      if (path.startsWith('/api/')) {
        const session = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('bp_session='))?.slice(11);
        if (!session || (sessions.get(session) || 0) < Date.now()) throw new ServiceError('請先登入。', 401);
        if (!['GET','HEAD'].includes(method)) {
          const origin = req.headers.origin;
          if (!origin || new URL(origin).host !== req.headers.host) throw new ServiceError('來源不符，請重新開啟此頁。', 403);
        }
        if (path === '/api/logout' && method === 'POST') {
          sessions.delete(session); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true });
        }
        if (path === '/api/state' && method === 'GET') return json(res, 200, {
          profile: store.value('profile'), settings: store.value('settings'), knowledge: store.all('SELECT * FROM knowledge ORDER BY created_at DESC'),
          conversations: store.conversations(), runtime: runtime(),
        });
        if (path === '/api/profile' && method === 'PUT') {
          const input = await body(req);
          const profile = { name: string(input.name,80,false), service: string(input.service,500,false), instructions: string(input.instructions,2000,false), tone: choice(input.tone,['friendly','formal']) };
          store.transaction(() => { store.set('profile', profile); store.revise(); store.audit('update_profile'); });
          return json(res, 200, { profile });
        }
        if (path === '/api/settings' && method === 'PUT') {
          const input = await body(req);
          const settings = { mode: choice(input.mode,['review','auto']), handoffContact: string(input.handoffContact,300,false) };
          store.transaction(() => { store.set('settings', settings); store.revise(); store.audit('update_settings'); });
          return json(res, 200, { settings });
        }
        if (path === '/api/knowledge' && method === 'POST') {
          const input = await body(req);
          const title = string(input.title,100), content = string(input.content,2000), category = choice(input.category,['price','hours','refund','general']);
          const expires = input.expiresAt ? Date.parse(string(input.expiresAt,40)) : null;
          if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) throw new ServiceError('有效期必須是未來日期。');
          if (store.get('SELECT count(*) AS n FROM knowledge').n >= 100) throw new ServiceError('第一版最多保存 100 條資料，請先整理舊資料。');
          const id = randomUUID();
          store.transaction(() => {
            store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', id, title, category, content, input.approved === true ? 1 : 0, expires, Date.now());
            store.revise(); store.audit(input.approved === true ? 'knowledge_approved' : 'knowledge_proposed', id);
          });
          return json(res, 201, { id });
        }
        const knowledge = path.match(/^\/api\/knowledge\/([\w-]+)$/);
        if (knowledge && ['POST','DELETE'].includes(method)) {
          const id = knowledge[1]; const item = store.get('SELECT * FROM knowledge WHERE id=?', id);
          if (!item) throw new ServiceError('找不到資料。', 404);
          if (method === 'POST' && item.expires_at && item.expires_at <= Date.now()) throw new ServiceError('資料已過期，請新增已更新的版本。');
          store.transaction(() => {
            store.run(method === 'DELETE' ? 'DELETE FROM knowledge WHERE id=?' : 'UPDATE knowledge SET approved=1 WHERE id=?', id);
            store.revise(); store.audit(method === 'DELETE' ? 'knowledge_deleted' : 'knowledge_approved', id);
          });
          return json(res, 200, { ok: true });
        }
        if (path === '/api/demo' && method === 'POST') {
          const input = await body(req); let address = randomUUID();
          if (input.conversationId) {
            const c = engine.requireConversation(string(input.conversationId,100));
            if (c.channel !== 'demo') throw new ServiceError('試聊不能寫入真實客戶對話。');
            address = c.address;
          }
          return json(res, 201, engine.receive({ address, text: string(input.text) }));
        }
        const conv = path.match(/^\/api\/conversations\/([\w-]+)(?:\/(takeover|resume|reply))?$/);
        if (conv) {
          const id = conv[1]; engine.requireConversation(id);
          if (method === 'GET' && !conv[2]) return json(res, 200, { conversation: store.conversation(id), messages: store.messages(id) });
          if (method === 'DELETE' && !conv[2]) {
            if (store.get("SELECT id FROM messages WHERE conversation_id=? AND status='sending'", id)) throw new ServiceError('仍有訊息正在發送，請稍後再刪除。',409);
            if (engine.running) throw new ServiceError('正在處理訊息，請稍後再刪除。',409);
            store.run('DELETE FROM conversations WHERE id=?', id); store.audit('conversation_deleted', id);
            return json(res,200,{ok:true});
          }
          if (method === 'POST' && ['takeover','resume'].includes(conv[2])) {
            engine.takeover(id, conv[2] === 'resume' ? 'ai' : 'human'); return json(res, 200, { ok: true });
          }
          if (method === 'POST' && conv[2] === 'reply') return json(res, 201, { id: engine.manualReply(id, string((await body(req)).text)) });
        }
        const approval = path.match(/^\/api\/messages\/([\w-]+)\/approve$/);
        if (approval && method === 'POST') { const input = await body(req); engine.approve(approval[1], string(input.text,4000,false)); return json(res,200,{ok:true}); }
        throw new ServiceError('找不到此操作。', 404);
      }
      const assets = { '/': ['index.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/style.css': ['style.css','text/css; charset=utf-8'] };
      if (method === 'GET' && assets[path]) {
        const [file, mime] = assets[path]; const content = await readFile(publicDir + file);
        res.writeHead(200, { 'Content-Type': mime }); return res.end(content);
      }
      throw new ServiceError('找不到此頁。', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof ServiceError ? error.status : 500, { error: error instanceof ServiceError ? error.message : '服務暫時未能完成，請稍後再試。' });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
