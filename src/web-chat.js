import { createHash, randomBytes, randomUUID } from 'node:crypto';

const COOKIE = 'bluesai_guest';
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('需要 JSON 格式。', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw fail('內容太長。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('JSON 內容不正確。'); }
}

// A guest cookie grants access only to this guest's web conversation. It is never
// an owner identity, and no owner endpoint accepts it. Tokens stay in HttpOnly
// cookies; only their hashes are persisted, so sessions survive a service restart.
export function createWebChat({ store, engine, cookieSecure = false, enabled = false, now = Date.now }) {
  const sessionAttempts = new Map();
  const conversation = session => store.get("SELECT * FROM conversations WHERE channel='web' AND address=?", session.address);
  const fromRequest = req => {
    const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
    return store.get('SELECT * FROM web_chat_sessions WHERE token_hash=? AND expires_at>?', hash(raw), now()) || null;
  };
  const requireSession = req => {
    const session = fromRequest(req);
    if (!session) throw fail('會話已過期，請重新開始。', 401);
    return session;
  };
  const requireOrigin = req => {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw fail('來源不符，請重新開啟此頁。', 403); }
    if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol) ||
        (cookieSecure && origin.protocol !== 'https:')) throw fail('來源不符，請重新開啟此頁。', 403);
  };

  return async function handle(req, res, path) {
    if (!path.startsWith('/chat/api/')) return false;
    try {
      if (!enabled) throw fail('網頁客服尚未開放。', 404);
      if (req.method === 'POST') requireOrigin(req);
      if (path === '/chat/api/session' && req.method === 'POST') {
        await readBody(req);
        let session = fromRequest(req);
        if (!session) {
          const stamp = now();
          for (const [ip, entry] of sessionAttempts) if (entry.until <= stamp) sessionAttempts.delete(ip);
          const ip = req.socket.remoteAddress || 'unknown';
          const entry = sessionAttempts.get(ip) || { count: 0, until: stamp + 15 * 60000 };
          if (entry.count >= 10 || (!sessionAttempts.has(ip) && sessionAttempts.size >= 1000)) throw fail('開始會話次數太多，請稍後再試。', 429);
          sessionAttempts.set(ip, { ...entry, count: entry.count + 1 });
          // Keep historical conversations for the owner's retention policy. This
          // bound applies to active guest tokens, not message deletion.
          if (store.get('SELECT count(*) AS n FROM web_chat_sessions WHERE expires_at>?', stamp).n >= 10000) throw fail('客服暫時繁忙，請稍後再試。', 503);
          const token = randomBytes(32).toString('hex');
          session = { token_hash: hash(token), address: randomUUID(), created_at: stamp, expires_at: stamp + SESSION_AGE, rate_window: stamp, message_count: 0 };
          store.run('INSERT INTO web_chat_sessions VALUES (?,?,?,?,?,?)', session.token_hash, session.address, session.created_at, session.expires_at, session.rate_window, 0);
          res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/chat; Max-Age=${SESSION_AGE / 1000}${cookieSecure ? '; Secure' : ''}`);
        }
        const c = conversation(session);
        json(res, 200, { ready: true, version: c?.version || 0 }); return true;
      }
      if (path === '/chat/api/messages' && req.method === 'GET') {
        const session = requireSession(req), c = conversation(session);
        if (!c) { json(res, 200, { conversation: null, version: 0, messages: [] }); return true; }
        const messages = store.messages(c.id).filter(m => m.role === 'user' ||
          (['assistant', 'staff'].includes(m.role) && ['accepted', 'delivered', 'read'].includes(m.status)))
          .map(m => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', text: m.content, status: m.status, createdAt: m.created_at }));
        json(res, 200, { conversation: { id: c.id, state: c.state }, version: c.version, messages }); return true;
      }
      if (path === '/chat/api/ack' && req.method === 'POST') {
        const input = await readBody(req), session = requireSession(req), c = conversation(session);
        if (!Array.isArray(input.messageIds) || input.messageIds.length > 100 || input.messageIds.some(id => typeof id !== 'string' || id.length > 100)) throw fail('收件確認無效。');
        // Browser acknowledges only after parsing/rendering the reply. This is
        // receipt by the guest client, not proof that a person has read it.
        if (c) store.transaction(() => {
          for (const id of input.messageIds) store.run("UPDATE messages SET status='delivered' WHERE id=? AND conversation_id=? AND role IN ('assistant','staff') AND status='accepted'", id, c.id);
        });
        json(res, 200, { acknowledged: true }); return true;
      }
      if (path === '/chat/api/messages' && req.method === 'POST') {
        // Read the session after the asynchronous body read. Parallel requests
        // must not reuse an earlier rate counter or expired authentication.
        const input = await readBody(req), session = requireSession(req);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw fail('請輸入 1 至 2000 字的訊息。');
        if (typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotencyKey)) throw fail('訊息識別碼無效。');
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw fail('會話版本無效。');
        const text = input.text.trim(), eventId = `${session.address}:${input.idempotencyKey}`;
        // The provider ID and dedup event are saved by Engine.receive in one
        // transaction. Retrying after an interrupted HTTP response is safe.
        const prior = store.get("SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.channel='web' AND c.address=? AND m.role='user' AND m.provider_id=?", session.address, eventId);
        if (prior) {
          if (prior.content !== text) throw fail('同一訊息識別碼不能用於另一段內容。', 409);
          json(res, 200, { received: true, duplicate: true, messageId: prior.id, version: conversation(session).version }); return true;
        }
        const c = conversation(session);
        if ((c?.version || 0) !== input.expectedVersion) throw fail('會話已更新，請先重新讀取再送出。', 409);
        const stamp = now();
        const count = stamp - session.rate_window >= 60000 ? 0 : session.message_count;
        if (count >= 20) throw fail('訊息太頻密，請稍候再試。', 429);
        if (c && store.get('SELECT count(*) AS n FROM messages WHERE conversation_id=?', c.id).n >= 1000) throw fail('此會話已達訊息上限，請聯絡人工。', 409);
        store.run('UPDATE web_chat_sessions SET rate_window=?,message_count=? WHERE token_hash=?', count === 0 ? stamp : session.rate_window, count + 1, session.token_hash);
        const result = engine.receive({ channel: 'web', address: session.address, name: '網頁訪客', eventId, text, timestamp: stamp });
        // An owner can delete a conversation while retaining dedup events.
        // Never claim a deleted request was saved as a new conversation.
        if (result.duplicate) throw fail('此訊息的會話已移除，請重新開始。', 410);
        json(res, 201, { received: true, duplicate: false, messageId: result.messageId, version: conversation(session).version }); return true;
      }
      throw fail('找不到此操作。', 404);
    } catch (error) {
      json(res, Number.isInteger(error.status) ? error.status : 500, { error: Number.isInteger(error.status) ? error.message : '客服暫時未能完成，請稍後再試。' });
      return true;
    }
  };
}
