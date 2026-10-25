import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';

const adminToken = 'guest-route-owner-test-'.repeat(3);
async function fixture(t, { path = ':memory:', enabled = true } = {}) {
  const store = new Store(path), engine = new Engine(store, createAgent(), createEvolution());
  const server = createApp({ store, engine, adminToken, webChatEnabled: enabled });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await engine.stop(); store.close(); };
  t.after(close);
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { method = 'GET', data, cookie, origin = base, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { response, data: await response.json() };
  }
  async function guest() {
    const result = await call('/chat/api/session', { method: 'POST', data: {} });
    assert.equal(result.response.status, 200);
    return result.response.headers.get('set-cookie').split(';')[0];
  }
  return { store, engine, server, base, call, guest, close };
}

test('web guest question reaches shared core; owner approval publishes; browser acknowledges receipt', async t => {
  const f = await fixture(t), cookie = await f.guest();
  f.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', 'price', '合成價錢', 'price', '合成驗收：HK$120。', 1, null, Date.now());
  const sent = await f.call('/chat/api/messages', { method: 'POST', cookie, data: { text: '幾錢？', idempotencyKey: 'test-message-1', expectedVersion: 0 } });
  assert.equal(sent.response.status, 201);
  await f.engine.tick();
  const row = f.store.get("SELECT * FROM conversations WHERE channel='web'");
  const draft = f.store.messages(row.id).at(-1);
  assert.equal(draft.status, 'draft');
  const before = await f.call('/chat/api/messages', { cookie });
  assert.equal(before.data.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(before.data), /HK\$120|合成價錢|sourceIds|instructions/);
  const login = await f.call('/api/login', { method: 'POST', data: { token: adminToken } });
  const owner = login.response.headers.get('set-cookie').split(';')[0];
  const approved = await f.call(`/api/messages/${draft.id}/approve`, { method: 'POST', cookie: owner, data: { text: '' } });
  assert.equal(approved.response.status, 200);
  await f.engine.tick();
  assert.equal(f.store.messages(row.id).at(-1).status, 'accepted');
  const received = await f.call('/chat/api/messages', { cookie });
  assert.equal(received.data.conversation.id, row.id);
  assert.equal(received.data.messages.at(-1).text, '合成驗收：HK$120。');
  assert.equal(f.store.messages(row.id).at(-1).status, 'accepted');
  await f.call('/chat/api/ack', { method: 'POST', cookie, data: { messageIds: [draft.id] } });
  const ownerRead = await f.call('/api/conversations/' + row.id, { cookie: owner });
  assert.equal(ownerRead.data.messages.at(-1).id, received.data.messages.at(-1).id);
  assert.equal(ownerRead.data.messages.at(-1).status, 'delivered');
  assert.equal(f.engine.evolution.configured, false);
});

test('guest sessions isolate conversations and acknowledgements and grant no owner access', async t => {
  const f = await fixture(t), first = await f.guest(), second = await f.guest();
  await f.call('/chat/api/messages', { method: 'POST', cookie: first, data: { text: '人工', idempotencyKey: 'private-message-1', expectedVersion: 0 } });
  const c = f.store.get("SELECT * FROM conversations WHERE channel='web'");
  f.engine.takeover(c.id); const id = f.engine.manualReply(c.id, '只給第一個訪客'); await f.engine.tick();
  assert.equal((await f.call('/chat/api/messages', { cookie: second })).data.messages.length, 0);
  await f.call('/chat/api/ack', { method: 'POST', cookie: second, data: { messageIds: [id] } });
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', id).status, 'accepted');
  assert.equal((await f.call('/api/state', { cookie: first })).response.status, 401);
  assert.equal((await f.call('/chat/api/messages')).response.status, 401);
  assert.equal((await f.call('/chat/api/messages', { cookie: 'bluesai_guest=bogus' })).response.status, 401);
  const rows = f.store.all('SELECT * FROM web_chat_sessions');
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(first.split('=')[1]));
});

test('web session and idempotent request survive restart with version conflicts rejected', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bluesai-guest-')), path = join(dir, 'test.sqlite');
  const first = await fixture(t, { path }), cookie = await first.guest();
  const data = { text: '重啟驗收', idempotencyKey: 'restart-message-1', expectedVersion: 0 };
  const original = await first.call('/chat/api/messages', { method: 'POST', cookie, data });
  assert.equal(original.response.status, 201); await first.close();
  const next = await fixture(t, { path });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const replay = await next.call('/chat/api/messages', { method: 'POST', cookie, data });
  assert.equal(replay.response.status, 200); assert.equal(replay.data.duplicate, true); assert.equal(replay.data.messageId, original.data.messageId);
  assert.equal(next.store.all("SELECT * FROM messages WHERE role='user'").length, 1);
  const conflict = await next.call('/chat/api/messages', { method: 'POST', cookie, data: { ...data, text: '另一段文字' } });
  assert.equal(conflict.response.status, 409);
  const stale = await next.call('/chat/api/messages', { method: 'POST', cookie, data: { ...data, idempotencyKey: 'restart-message-2' } });
  assert.equal(stale.response.status, 409);
  assert.equal((await next.call('/chat/api/messages', { cookie })).data.messages[0].text, data.text);
});

test('web guest mutations require same origin, bounded text, version and request IDs', async t => {
  const f = await fixture(t), cookie = await f.guest();
  const input = { text: '測試', idempotencyKey: 'validation-message', expectedVersion: 0 };
  for (const origin of ['https://unrelated.test', null]) assert.equal((await f.call('/chat/api/messages', { method: 'POST', cookie, origin, data: input })).response.status, 403);
  for (const data of [{ ...input, text: '' }, { ...input, text: 'x'.repeat(2001) }, { ...input, expectedVersion: -1 }, { ...input, idempotencyKey: '../bad' }]) {
    assert.equal((await f.call('/chat/api/messages', { method: 'POST', cookie, data })).response.status, 400);
  }
  assert.equal((await f.call('/chat/api/ack', { method: 'POST', cookie, data: { messageIds: [null] } })).response.status, 400);
  assert.equal((await f.call('/chat/api/messages', { method: 'POST', cookie, data: input, headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  assert.equal(f.store.conversations().length, 0);
});

test('web message rate limit is per session and persists in SQLite', async t => {
  const f = await fixture(t), cookie = await f.guest();
  for (let i = 0; i < 20; i++) {
    const result = await f.call('/chat/api/messages', { method: 'POST', cookie, data: { text: '合成限速測試', idempotencyKey: 'rate-message-' + i, expectedVersion: i } });
    assert.equal(result.response.status, 201, String(i));
  }
  const blocked = await f.call('/chat/api/messages', { method: 'POST', cookie, data: { text: '合成限速測試', idempotencyKey: 'rate-message-20', expectedVersion: 20 } });
  assert.equal(blocked.response.status, 429);
  assert.equal(f.store.get('SELECT message_count FROM web_chat_sessions').message_count, 20);
  const replay = await f.call('/chat/api/messages', { method: 'POST', cookie, data: { text: '合成限速測試', idempotencyKey: 'rate-message-0', expectedVersion: 0 } });
  assert.equal(replay.response.status, 200);
});

test('guest route is disabled unless explicitly enabled and chat assets are local', async t => {
  const disabled = await fixture(t, { enabled: false });
  assert.equal((await disabled.call('/chat/api/session', { method: 'POST', data: {} })).response.status, 404);
  assert.equal(disabled.store.all('SELECT * FROM web_chat_sessions').length, 0);
  const f = await fixture(t);
  for (const path of ['/chat', '/chat.js', '/chat.css']) assert.equal((await fetch(f.base + path)).status, 200);
  const html = await (await fetch(f.base + '/chat')).text();
  assert.match(html, /maxlength="2000"/); assert.doesNotMatch(html, /admin-token|apiKey|<iframe/);
});

test('concurrent guest requests cannot reuse a stale session rate counter while reading bodies', async t => {
  const f = await fixture(t), cookie = await f.guest();
  let headerCount = 0, headersReady;
  const ready = new Promise(resolve => { headersReady = resolve; });
  const observe = req => { if (req.url === '/chat/api/messages' && ++headerCount === 21) headersReady(); };
  f.server.on('request', observe);
  const pending = Array.from({ length: 21 }, (_, i) => {
    const body = JSON.stringify({ text: '並行限速驗收', idempotencyKey: 'parallel-message-' + i, expectedVersion: i });
    let request;
    const response = new Promise((resolve, reject) => {
      request = httpRequest(f.base + '/chat/api/messages', { method: 'POST', agent: false, headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: f.base, Cookie: cookie,
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      request.on('error', reject); request.flushHeaders();
    });
    return { request, response, body };
  });
  try {
    await ready;
    for (let i = 0; i < pending.length; i++) {
      pending[i].request.end(pending[i].body);
      assert.equal(await pending[i].response, i < 20 ? 201 : 429, String(i));
    }
    assert.equal(f.store.get('SELECT message_count FROM web_chat_sessions').message_count, 20);
  } finally {
    f.server.off('request', observe); for (const item of pending) item.request.destroy();
  }
});
