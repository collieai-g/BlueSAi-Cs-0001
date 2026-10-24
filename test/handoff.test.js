import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const answer = { text: '已確認的示範答案。', decision: 'answer', sourceIds: [], engine: 'mock' };
const immediateAgent = { configured: true, async reply() { return answer; } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const store = new Store(':memory:');
  const sent = [];
  let now = Date.now();
  const provider = options.provider || {
    configured: true, deliveryEnabled: true,
    async send(address, text) { sent.push({ address, text }); return { providerId: `mock-${sent.length}` }; },
  };
  const engine = new Engine(store, options.agent || immediateAgent, provider, {
    now: () => now, ...options.engineOptions,
  });
  t.after(async () => {
    options.release?.();
    await engine.stop();
    store.close();
  });
  return { store, engine, sent, time: () => now, advance(ms) { now += ms; } };
}

function ready(store, mode = 'review') {
  store.set('profile', { name: '模擬商戶', industry: '', service: '測試服務', instructions: '', tone: 'friendly' });
  store.set('settings', { mode, handoffContact: '僅供本機測試的接管位置' });
}

function windows(store, id) {
  return store.all('SELECT * FROM response_windows WHERE conversation_id=? ORDER BY opened_at, rowid', id);
}

function tasks(store, id) {
  return store.all('SELECT * FROM handoff_tasks WHERE conversation_id=?', id);
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for independent deadline monitor');
    await delay(10);
  }
}

function temporaryDatabase() {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'bluesai-handoff-'));
  return {
    path: join(dir, 'service.sqlite'),
    remove() {
      const resolved = realpathSync(dir);
      assert.equal(dirname(resolved), parent);
      assert.ok(basename(resolved).startsWith('bluesai-handoff-'));
      rmSync(resolved, { recursive: true });
    },
  };
}

test('deadline interrupts a waiting model, persists one handoff task and discards its late answer', async t => {
  const pending = deferred();
  const f = fixture(t, { agent: { configured: true, reply: () => pending.promise }, release: () => pending.resolve(answer) });
  const r = f.engine.receive({ text: '想了解服務' });
  const running = f.engine.tick();
  assert.equal(f.store.get('SELECT state FROM jobs WHERE id=?', r.messageId).state, 'running');
  const window = windows(f.store, r.conversationId)[0];
  assert.equal(window.deadline_at - window.opened_at, 30_000);
  f.advance(29_999);
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(r.conversationId).state, 'ai');
  f.advance(1);
  f.engine.checkDeadlines();
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(windows(f.store, r.conversationId)[0].status, 'handed_off');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
  assert.equal(tasks(f.store, r.conversationId)[0].status, 'pending');
  assert.equal(f.engine.running, true);
  pending.resolve(answer);
  await running;
  await f.engine.tick();
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'assistant').length, 0);
  assert.equal(tasks(f.store, r.conversationId).length, 1);
  assert.equal(f.sent.length, 0);
});

test('a burst and duplicate incoming event do not extend the earliest unanswered deadline', t => {
  const f = fixture(t);
  const first = f.engine.receive({ address: 'same-customer', eventId: 'first', text: '第一個問題' });
  const original = windows(f.store, first.conversationId)[0];
  f.advance(25_000);
  f.engine.receive({ address: 'same-customer', eventId: 'second', text: '補充資料' });
  assert.equal(f.engine.receive({ address: 'same-customer', eventId: 'second', text: '補充資料' }).duplicate, true);
  const current = windows(f.store, first.conversationId);
  assert.equal(current.length, 1);
  assert.equal(current[0].first_message_id, first.messageId);
  assert.equal(current[0].deadline_at, original.deadline_at);
  f.advance(5_000);
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(first.conversationId).state, 'waiting');
  assert.equal(tasks(f.store, first.conversationId).length, 1);
});

test('a completed draft is not an answer and cannot be approved at the deadline', async t => {
  const f = fixture(t);
  const r = f.engine.receive({ text: '請回答問題' });
  await f.engine.tick();
  const draft = f.store.messages(r.conversationId).find(m => m.role === 'assistant');
  assert.equal(draft.status, 'draft');
  assert.equal(windows(f.store, r.conversationId)[0].status, 'pending');
  f.advance(30_000);
  assert.throws(() => f.engine.approve(draft.id), error => error.status === 409);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', draft.id).status, 'cancelled');
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
});

test('queued answer cannot cross the submission boundary after expiry even before monitor runs', async t => {
  const f = fixture(t);
  ready(f.store);
  const r = f.engine.receive({ channel: 'evolution', address: '15551234567@s.whatsapp.net', text: '請回答問題' });
  await f.engine.tick();
  const draft = f.store.messages(r.conversationId).find(m => m.role === 'assistant');
  f.engine.approve(draft.id);
  const queued = f.store.get('SELECT * FROM messages WHERE id=?', draft.id);
  assert.equal(queued.status, 'queued');
  f.advance(30_000);
  await f.engine.dispatch(queued);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', draft.id).status, 'cancelled');
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(f.sent.length, 0);
  assert.equal(tasks(f.store, r.conversationId).length, 1);
});

test('generation completion checks the deadline when no scheduler tick has occurred', async t => {
  const pending = deferred();
  const f = fixture(t, { agent: { configured: true, reply: () => pending.promise }, release: () => pending.resolve(answer) });
  const r = f.engine.receive({ text: '問題' });
  const running = f.engine.tick();
  f.advance(30_000);
  pending.resolve(answer);
  await running;
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'assistant').length, 0);
  assert.equal(tasks(f.store, r.conversationId).length, 1);
});

test('manual reply dispatch stays available after timeout while the original model is still unresolved', async t => {
  const pending = deferred();
  let modelFinished = false;
  const f = fixture(t, {
    agent: { configured: true, async reply() {
      try { return await pending.promise; } finally { modelFinished = true; }
    } },
    release: () => pending.resolve(answer),
  });
  ready(f.store);
  const r = f.engine.receive({ channel: 'evolution', address: '15551234567@s.whatsapp.net', text: '需要服務資料' });
  const originalTick = f.engine.tick();
  f.advance(30_000);
  f.engine.checkDeadlines();
  f.engine.takeover(r.conversationId);
  const staffId = f.engine.manualReply(r.conversationId, '我已接手，現在幫你查看。');
  await f.engine.tick();
  assert.equal(modelFinished, false);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', staffId).status, 'accepted');
  assert.deepEqual(f.sent.map(x => x.text), ['我已接手，現在幫你查看。']);
  assert.equal(f.store.conversation(r.conversationId).state, 'human');
  pending.resolve(answer);
  await originalTick;
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'assistant').length, 0);
  assert.equal(f.sent.length, 1);
});

test('late model rejection cannot hand off a fresh window after timeout takeover and resume', async t => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(t, {
    agent: { configured: true, reply() { return ++calls === 1 ? pending.promise : Promise.resolve(answer); } },
    release: () => pending.resolve(answer),
  });
  const r = f.engine.receive({ address: 'customer', text: '舊問題' });
  const originalTick = f.engine.tick();
  f.advance(30_000);
  f.engine.checkDeadlines();
  f.engine.takeover(r.conversationId);
  f.engine.takeover(r.conversationId, 'ai');
  const fresh = f.engine.receive({ address: 'customer', text: '新問題' });
  const freshWindow = windows(f.store, r.conversationId).at(-1);
  pending.reject(new Error('old request failed after the new question arrived'));
  await originalTick;
  assert.equal(f.store.conversation(r.conversationId).state, 'ai');
  assert.equal(windows(f.store, r.conversationId).at(-1).id, freshWindow.id);
  assert.equal(windows(f.store, r.conversationId).at(-1).status, 'pending');
  assert.equal(windows(f.store, r.conversationId).at(-1).deadline_at, freshWindow.deadline_at);
  assert.equal(f.store.get('SELECT state FROM jobs WHERE id=?', fresh.messageId).state, 'pending');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'system' && m.status === 'failed').length, 0);
  await f.engine.tick();
  assert.equal(calls, 2);
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'assistant').length, 1);
  assert.equal(f.store.conversation(r.conversationId).state, 'ai');
});

test('a stale job captured before expiry cannot restart generation after handoff', async t => {
  let calls = 0;
  const f = fixture(t, { agent: { configured: true, async reply() { calls++; return answer; } } });
  const r = f.engine.receive({ text: '問題' });
  const stale = f.store.get('SELECT * FROM jobs WHERE id=?', r.messageId);
  f.advance(30_000);
  f.engine.checkDeadlines();
  await f.engine.processJob(stale);
  assert.equal(calls, 0);
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
});

test('already overdue pending work is handed off before starting the model', async t => {
  let calls = 0;
  const f = fixture(t, { agent: { configured: true, async reply() { calls++; return answer; } } });
  const r = f.engine.receive({ text: '問題' });
  f.advance(30_000);
  await f.engine.tick();
  assert.equal(calls, 0);
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
});

test('restart preserves the original deadline and atomically hands off overdue work once', async t => {
  const db = temporaryDatabase();
  let now = Date.now(), store, engine;
  t.after(async () => { if (engine) await engine.stop(); store?.close(); db.remove(); });
  store = new Store(db.path);
  engine = new Engine(store, immediateAgent, {}, { now: () => now });
  const r = engine.receive({ text: '跨重啟問題' });
  const original = windows(store, r.conversationId)[0];
  await engine.stop(); store.close(); engine = null; store = null;
  now += 30_000;
  store = new Store(db.path);
  engine = new Engine(store, immediateAgent, {}, { now: () => now });
  assert.equal(windows(store, r.conversationId)[0].id, original.id);
  assert.equal(windows(store, r.conversationId)[0].deadline_at, original.deadline_at);
  assert.equal(store.conversation(r.conversationId).state, 'waiting');
  assert.equal(tasks(store, r.conversationId).length, 1);
  engine.checkDeadlines();
  await engine.stop(); store.close(); engine = null; store = null;
  store = new Store(db.path);
  engine = new Engine(store, immediateAgent, {}, { now: () => now });
  assert.equal(tasks(store, r.conversationId).length, 1);
  assert.equal(store.messages(r.conversationId).filter(m => m.role === 'user').length, 1);
});

test('additive migration preserves legacy data and does not invent deadlines for old conversations', async t => {
  const db = temporaryDatabase();
  let store, engine;
  t.after(async () => { if (engine) await engine.stop(); store?.close(); db.remove(); });
  const old = new DatabaseSync(db.path);
  const profile = { name: '保留商戶', service: '', instructions: '保留指令', tone: 'formal' };
  try {
    old.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ai', version INTEGER NOT NULL DEFAULT 0, last_customer_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, UNIQUE(channel,address));
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT,
        version INTEGER NOT NULL, config_version INTEGER NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
        decision TEXT, engine TEXT, created_at INTEGER NOT NULL);
    `);
    old.prepare('INSERT INTO config VALUES (?,?)').run('profile', JSON.stringify(profile));
    old.prepare('INSERT INTO config VALUES (?,?)').run('revision', '9');
    old.prepare('INSERT INTO config VALUES (?,?)').run('settings', JSON.stringify({ mode: 'review', handoffContact: '' }));
    old.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)').run('legacy-case', 'demo', 'legacy', '', 'ai', 7, 1, 1);
    old.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-message', 'legacy-case', 'user', '舊對話原文', 'received', null, 7, 9, '[]', null, null, 1);
    old.prepare('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)').run('legacy-fact', '保留記憶', 'general', '已核對資料', 1, null, 1);
  } finally { old.close(); }
  store = new Store(db.path);
  engine = new Engine(store, immediateAgent, {}, { now: () => Date.now() });
  assert.deepEqual(store.value('profile'), profile);
  assert.equal(store.value('revision'), 9);
  assert.equal(store.messages('legacy-case')[0].content, '舊對話原文');
  assert.equal(store.facts()[0].id, 'legacy-fact');
  assert.equal(store.conversation('legacy-case').state, 'ai');
  assert.equal(store.conversation('legacy-case').version, 7);
  assert.equal(windows(store, 'legacy-case').length, 0);
  assert.equal(tasks(store, 'legacy-case').length, 0);
  const versions = store.all('SELECT version FROM schema_migrations ORDER BY version');
  assert.ok(versions.length > 0);
  assert.equal(new Set(versions.map(x => x.version)).size, versions.length);
  await engine.stop(); store.close(); engine = null; store = null;
  store = new Store(db.path);
  assert.deepEqual(store.all('SELECT version FROM schema_migrations ORDER BY version'), versions);
  assert.equal(store.messages('legacy-case')[0].content, '舊對話原文');
});

test('manual takeover closes the old window and resume waits for fresh input before opening another', t => {
  const f = fixture(t);
  const r = f.engine.receive({ address: 'customer', text: '第一個問題' });
  f.engine.takeover(r.conversationId);
  assert.equal(windows(f.store, r.conversationId)[0].status, 'cancelled');
  f.advance(35_000);
  f.engine.receive({ address: 'customer', text: '人工處理期間的問題' });
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(r.conversationId).state, 'human');
  assert.equal(windows(f.store, r.conversationId).length, 1);
  assert.equal(tasks(f.store, r.conversationId).length, 0);
  f.engine.takeover(r.conversationId, 'ai');
  f.engine.checkDeadlines();
  assert.equal(windows(f.store, r.conversationId).length, 1);
  const fresh = f.engine.receive({ address: 'customer', text: '交回 AI 後的新問題' });
  const all = windows(f.store, r.conversationId);
  assert.equal(all.length, 2);
  assert.equal(all[1].first_message_id, fresh.messageId);
  assert.equal(all[1].deadline_at, f.time() + 30_000);
  assert.equal(all[1].status, 'pending');
});

for (const reason of ['agent-requested', 'model-failure']) {
  test(`${reason} creates one durable local handoff task without sending an external reminder`, async t => {
    const f = fixture(t, {
      agent: { configured: true, async reply() {
        if (reason === 'model-failure') throw new Error('mock provider failure');
        return { ...answer, decision: 'handoff' };
      } },
    });
    const r = f.engine.receive({ text: '需要客服協助' });
    await f.engine.tick();
    assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
    assert.equal(windows(f.store, r.conversationId)[0].status, 'handed_off');
    assert.equal(tasks(f.store, r.conversationId).length, 1);
    f.advance(30_000);
    f.engine.checkDeadlines();
    await f.engine.tick();
    assert.equal(tasks(f.store, r.conversationId).length, 1);
    assert.equal(f.sent.length, 0);
  });
}

test('inflight submission stays recorded after the deadline and an unknown outcome is not retried', async t => {
  const send = deferred(), started = deferred();
  let calls = 0;
  const f = fixture(t, {
    provider: { configured: true, deliveryEnabled: true, send() { calls++; started.resolve(); return send.promise; } },
    release: () => send.resolve({ providerId: 'cleanup-only' }),
  });
  ready(f.store, 'auto');
  const r = f.engine.receive({ channel: 'evolution', address: '15551234567@s.whatsapp.net', text: '問題' });
  const running = f.engine.tick();
  await started.promise;
  const m = f.store.messages(r.conversationId).find(x => x.role === 'assistant');
  assert.equal(m.status, 'sending');
  assert.equal(windows(f.store, r.conversationId)[0].status, 'submitted');
  f.advance(30_000);
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(r.conversationId).state, 'ai');
  assert.equal(tasks(f.store, r.conversationId).length, 0);
  send.reject(new Error('mock ambiguous provider timeout'));
  await running;
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', m.id).status, 'uncertain');
});

test('an earlier inflight send completing cannot resolve the next incoming question or resend its stale message', async t => {
  const send = deferred(), started = deferred();
  let calls = 0;
  const f = fixture(t, {
    provider: { configured: true, deliveryEnabled: true, send() { calls++; started.resolve(); return send.promise; } },
    release: () => send.resolve({ providerId: 'cleanup-only' }),
  });
  ready(f.store, 'auto');
  const r = f.engine.receive({ channel: 'evolution', address: '15551234567@s.whatsapp.net', text: '第一個問題' });
  const originalTick = f.engine.tick();
  await started.promise;
  const earlier = f.store.get("SELECT * FROM messages WHERE conversation_id=? AND role='assistant'", r.conversationId);
  assert.equal(earlier.status, 'sending');
  f.advance(10_000);
  const fresh = f.engine.receive({ channel: 'evolution', address: '15551234567@s.whatsapp.net', text: '另一個問題' });
  const freshWindow = windows(f.store, r.conversationId).at(-1);
  assert.equal(freshWindow.first_message_id, fresh.messageId);
  send.resolve({ providerId: 'confirmed-earlier-send' });
  await originalTick;
  assert.equal(windows(f.store, r.conversationId).at(-1).id, freshWindow.id);
  assert.equal(windows(f.store, r.conversationId).at(-1).status, 'pending');
  assert.equal(windows(f.store, r.conversationId).at(-1).deadline_at, freshWindow.deadline_at);
  await f.engine.dispatch({ ...earlier, status: 'queued' });
  assert.equal(calls, 1);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', earlier.id).status, 'accepted');
  f.advance(30_000);
  f.engine.checkDeadlines();
  assert.equal(f.store.conversation(r.conversationId).state, 'waiting');
  assert.equal(tasks(f.store, r.conversationId).length, 1);
  assert.equal(tasks(f.store, r.conversationId)[0].window_id, freshWindow.id);
});

test('submitted clarification waits for the customer and the next input starts a fresh deadline', async t => {
  const f = fixture(t, { agent: { configured: true, async reply() { return { ...answer, decision: 'clarify' }; } } });
  const r = f.engine.receive({ address: 'customer', text: '問題' });
  await f.engine.tick();
  const draft = f.store.messages(r.conversationId).find(m => m.role === 'assistant');
  assert.equal(windows(f.store, r.conversationId)[0].status, 'pending');
  f.engine.approve(draft.id);
  await f.engine.tick();
  assert.equal(windows(f.store, r.conversationId)[0].status, 'waiting_customer');
  f.advance(35_000);
  f.engine.checkDeadlines();
  assert.equal(tasks(f.store, r.conversationId).length, 0);
  const fresh = f.engine.receive({ address: 'customer', text: '補充資料' });
  const all = windows(f.store, r.conversationId);
  assert.equal(all.length, 2);
  assert.equal(all[1].first_message_id, fresh.messageId);
  assert.equal(all[1].deadline_at, f.time() + 30_000);
});

test('independent monitor runs while the worker awaits a model result', async t => {
  const pending = deferred();
  const f = fixture(t, {
    agent: { configured: true, reply: () => pending.promise },
    engineOptions: { now: Date.now, responseTimeoutMs: 150, deadlinePollMs: 10 },
    release: () => pending.resolve(answer),
  });
  const r = f.engine.receive({ text: '等待模型的問題' });
  f.engine.start();
  const running = f.engine.tick();
  await waitUntil(() => f.store.conversation(r.conversationId).state === 'waiting');
  assert.equal(f.engine.running, true);
  assert.equal(tasks(f.store, r.conversationId).length, 1);
  pending.resolve(answer);
  await running;
  assert.equal(f.store.messages(r.conversationId).filter(m => m.role === 'assistant').length, 0);
});

test('invalid deadline configuration is rejected instead of silently disabling monitoring', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const options of [
    { responseTimeoutMs: 0 }, { responseTimeoutMs: -1 }, { responseTimeoutMs: NaN },
    { responseTimeoutMs: Infinity }, { deadlinePollMs: 0 }, { deadlinePollMs: -1 },
  ]) assert.throws(() => new Engine(store, immediateAgent, {}, options));
});
