import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createApp } from '../src/server.js';

const endpoint = '/api/workbench/dot/tasks';
const adminToken = 'dot-task-local-test-'.repeat(3);

async function fixture(t, { path = ':memory:', workbench = true } = {}) {
  const store = new Store(path);
  let modelCalls = 0, sendCalls = 0;
  const agent = { configured: false, async reply() { modelCalls++; throw new Error('No model calls allowed'); } };
  const evolution = { configured: false, deliveryEnabled: false, async send() { sendCalls++; throw new Error('No sending allowed'); } };
  const engine = new Engine(store, agent, evolution);
  const connections = workbench ? { status: () => ({ ai: { status: 'unconfigured' }, whatsapp: { status: 'unconfigured' } }) } : null;
  const server = createApp({ store, engine, adminToken, workbench: connections });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: adminToken }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base, 'Content-Type': 'application/json' };
  const call = async (path, method = 'GET', data) => {
    const response = await fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => server.close(resolve));
    await engine.stop();
    store.close();
  };
  t.after(close);
  return { store, engine, base, headers, call, close, calls: () => ({ modelCalls, sendCalls }) };
}

function fact(store, { id = randomUUID(), content, approved = 1, expiresAt = null, category = 'general' }) {
  store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', id, '測試記憶', category, content, approved, expiresAt, Date.now());
  return id;
}

async function create(f, instruction = '請檢查這份客服設定，只回傳建議草稿。', idempotencyKey = randomUUID()) {
  const response = await f.call(endpoint, 'POST', { instruction, idempotencyKey });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.ok(response.data.task?.id);
  return response.data.task;
}

async function update(f, task, action, extra = {}) {
  return f.call(`${endpoint}/${encodeURIComponent(task.id)}`, 'PUT', { action, expectedVersion: task.version, ...extra });
}

const resultFor = (task, text = '這是供商戶檢查的回覆草稿。') => ({ taskId: task.id, verificationCode: task.verificationCode, text });

test('DOT task snapshots include only allowlisted profile and approved current knowledge without model or channel calls', async t => {
  const f = await fixture(t);
  f.store.set('profile', {
    name: '測試商戶', industry: '零售與網店', service: '測試服務', instructions: '簡短專業', tone: 'friendly',
    apiKey: 'MOCK_SECRET_SHOULD_NOT_BE_EXPORTED', privateCustomerData: 'PRIVATE_PROFILE_EXTRA',
  });
  f.store.set('settings', { mode: 'review', handoffContact: 'PRIVATE_OWNER_PHONE' });
  fact(f.store, { id: 'approved', content: 'APPROVED_CURRENT_FACT' });
  fact(f.store, { id: 'pending', content: 'PENDING_POLICY_PRIVATE', approved: 0 });
  fact(f.store, { id: 'expired', content: 'EXPIRED_POLICY_PRIVATE', expiresAt: Date.now() - 1 });
  f.engine.receive({ address: 'PRIVATE_CUSTOMER_ADDRESS', text: 'PRIVATE_CUSTOMER_CONVERSATION' });
  const task = await create(f);
  assert.equal(task.status, 'prepared');
  assert.equal(task.contextStale, false);
  assert.equal(task.version, 1);
  assert.equal(task.snapshot.profile.name, '測試商戶');
  assert.deepEqual(task.snapshot.facts.map(x => x.id), ['approved']);
  assert.ok(task.prompt.includes(task.id));
  assert.ok(task.prompt.includes(task.verificationCode));
  assert.match(task.prompt, /APPROVED_CURRENT_FACT/);
  assert.doesNotMatch(JSON.stringify(task), /MOCK_SECRET|PRIVATE_PROFILE_EXTRA|PRIVATE_OWNER_PHONE|PENDING_POLICY_PRIVATE|EXPIRED_POLICY_PRIVATE|PRIVATE_CUSTOMER_/);
  const detail = await f.call(`${endpoint}/${task.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.task.snapshot, task.snapshot);
  assert.deepEqual(f.calls(), { modelCalls: 0, sendCalls: 0 });
});

test('DOT task creation is idempotent without silently replacing a snapshot after profile changes', async t => {
  const f = await fixture(t), key = randomUUID();
  f.store.set('profile', { ...f.store.value('profile'), name: '最初商戶' });
  const original = await create(f, '  整理回覆草稿  ', key);
  const replay = await f.call(endpoint, 'POST', { instruction: '整理回覆草稿', idempotencyKey: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.task.id, original.id);
  f.store.set('profile', { ...f.store.value('profile'), name: '更新後商戶' });
  f.store.revise();
  const afterChange = await f.call(endpoint, 'POST', { instruction: '整理回覆草稿', idempotencyKey: key });
  assert.equal(afterChange.status, 200);
  assert.equal(afterChange.data.task.id, original.id);
  assert.equal(afterChange.data.task.prompt, original.prompt);
  assert.equal(afterChange.data.task.snapshot.profile.name, '最初商戶');
  assert.equal(afterChange.data.task.contextStale, true);
  assert.equal((await f.call(endpoint, 'POST', { instruction: '另一個任務', idempotencyKey: key })).status, 409);
  assert.equal((await f.call(endpoint)).data.tasks.length, 1);
});

test('DOT task copy/open/host-submission states are versioned and never mean DOT completed work', async t => {
  const f = await fixture(t);
  let task = await create(f);
  assert.equal((await f.call(`${endpoint}/${task.id}`, 'PUT', { action: 'copied' })).status, 400);
  const opened = await update(f, task, 'opened');
  assert.equal(opened.status, 200);
  assert.equal(opened.data.task.status, 'opened');
  assert.equal(opened.data.task.version, task.version + 1);
  assert.equal((await update(f, task, 'copied')).status, 409, 'stale client update is rejected');
  task = opened.data.task;
  const backwards = await update(f, task, 'copied');
  assert.equal(backwards.status, 200);
  assert.equal(backwards.data.task.status, 'opened', 'older launch receipt cannot move the state backwards');
  assert.equal(backwards.data.task.version, task.version);
  const submitted = await update(f, task, 'host_submitted');
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.task.status, 'host_submitted');
  assert.ok(!submitted.data.task.resultText);
  assert.equal(f.store.all("SELECT * FROM messages WHERE role IN ('assistant','staff')").length, 0);
  assert.deepEqual(f.calls(), { modelCalls: 0, sendCalls: 0 });
});

test('DOT task result requires the matching task association and stays a saved draft rather than knowledge or customer delivery', async t => {
  const f = await fixture(t);
  const task = await create(f);
  const beforeKnowledge = f.store.all('SELECT * FROM knowledge');
  for (const result of [
    { ...resultFor(task), taskId: randomUUID() },
    { ...resultFor(task), verificationCode: 'incorrect-code' },
    { ...resultFor(task), text: '' },
    { ...resultFor(task), text: 'x'.repeat(8001) },
  ]) assert.ok((await update(f, task, 'save_result', { result })).status >= 400);
  assert.equal((await f.call(`${endpoint}/${task.id}`)).data.task.status, 'prepared');
  const saved = await update(f, task, 'save_result', { result: resultFor(task) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.task.status, 'result_saved');
  assert.equal(saved.data.task.resultText, resultFor(task).text);
  assert.deepEqual(f.store.all('SELECT * FROM knowledge'), beforeKnowledge);
  assert.equal(f.store.conversations().length, 0);
  assert.equal(f.store.all('SELECT * FROM messages').length, 0);
  assert.deepEqual(f.calls(), { modelCalls: 0, sendCalls: 0 });
  assert.equal((await update(f, saved.data.task, 'opened')).status, 409);
  assert.equal((await update(f, saved.data.task, 'cancel')).status, 409);
  assert.equal((await update(f, saved.data.task, 'save_result', { result: resultFor(task, '嘗試覆寫') })).status, 409);
});

test('DOT task cancellation is terminal and cannot accept a late result', async t => {
  const f = await fixture(t), task = await create(f);
  const cancelled = await update(f, task, 'cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.task.status, 'cancelled');
  assert.equal((await update(f, cancelled.data.task, 'host_submitted')).status, 409);
  assert.equal((await update(f, cancelled.data.task, 'save_result', { result: resultFor(task) })).status, 409);
  assert.ok(!(await f.call(`${endpoint}/${task.id}`)).data.task.resultText);
});

test('DOT task results cannot adopt stale profile revisions or knowledge that expires or changes without a revision bump', async t => {
  const f = await fixture(t);
  const id = fact(f.store, { content: '已確認資料', expiresAt: Date.now() + 60000 });
  const revisionTask = await create(f);
  f.store.revise();
  assert.equal((await update(f, revisionTask, 'save_result', { result: resultFor(revisionTask) })).status, 409);
  const changedTask = await create(f);
  f.store.run('UPDATE knowledge SET content=? WHERE id=?', '資料已被改動', id);
  assert.equal((await update(f, changedTask, 'save_result', { result: resultFor(changedTask) })).status, 409);
  const expiredTask = await create(f);
  f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?', Date.now() - 1, id);
  assert.equal((await update(f, expiredTask, 'save_result', { result: resultFor(expiredTask) })).status, 409);
  const revoked = fact(f.store, { content: '將被撤銷資料' });
  const revokedTask = await create(f);
  f.store.run('UPDATE knowledge SET approved=0 WHERE id=?', revoked);
  assert.equal((await update(f, revokedTask, 'save_result', { result: resultFor(revokedTask) })).status, 409);
});

test('DOT task routes require authenticated same-origin workbench access and reject malformed input', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + endpoint)).status, 401);
  const cross = await fetch(f.base + endpoint, {
    method: 'POST', headers: { ...f.headers, Origin: 'https://unrelated.example.test' },
    body: JSON.stringify({ instruction: '任務', idempotencyKey: randomUUID() }),
  });
  assert.equal(cross.status, 403);
  for (const input of [
    {}, { instruction: '', idempotencyKey: 'key' }, { instruction: 'x'.repeat(2001), idempotencyKey: 'key' },
    { instruction: '任務' }, { instruction: '任務', idempotencyKey: '' },
    { instruction: '任務', idempotencyKey: 'x'.repeat(101) }, { instruction: '任務', idempotencyKey: '../bad key' },
  ]) assert.equal((await f.call(endpoint, 'POST', input)).status, 400);
  assert.equal((await f.call(`${endpoint}/missing`)).status, 404);
  const task = await create(f);
  assert.equal((await update(f, task, 'invented_status')).status, 400);
  const plain = await fixture(t, { workbench: false });
  assert.equal((await plain.call(endpoint)).status, 404);
  assert.equal((await plain.call(endpoint, 'POST', { instruction: '任務', idempotencyKey: randomUUID() })).status, 404);
});

test('DOT task storage is bounded and list responses expose safe summaries only', async t => {
  const f = await fixture(t);
  let last;
  for (let i = 0; i < 100; i++) last = await create(f, `檢查任務 ${i}`, `bounded-${i}`);
  const list = await f.call(endpoint);
  assert.equal(list.status, 200);
  assert.equal(list.data.tasks.length, 20);
  for (const task of list.data.tasks) {
    assert.ok(task.id);
    assert.ok(!Object.hasOwn(task, 'prompt'));
    assert.ok(!Object.hasOwn(task, 'snapshot'));
    assert.ok(!Object.hasOwn(task, 'verificationCode'));
    assert.ok(!Object.hasOwn(task, 'resultText'));
  }
  assert.equal((await f.call(endpoint, 'POST', { instruction: '超過上限', idempotencyKey: 'bounded-overflow' })).status, 409);
  const replay = await f.call(endpoint, 'POST', { instruction: '檢查任務 99', idempotencyKey: 'bounded-99' });
  assert.equal(replay.status, 200, 'idempotent recovery remains available at the capacity limit');
  assert.equal(replay.data.task.id, last.id);
});

test('DOT task snapshot byte limit rejects oversized context without creating a partial task', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) fact(f.store, { id: `large-${i}`, content: '資料'.repeat(1000) });
  const response = await f.call(endpoint, 'POST', { instruction: '檢查大量資料', idempotencyKey: 'large-context' });
  assert.equal(response.status, 413);
  assert.equal((await f.call(endpoint)).data.tasks.length, 0);
});

test('DOT task migration and restart preserve existing handoff state and immutable saved tasks', async t => {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'bluesai-dot-task-'));
  const path = join(dir, 'store.sqlite');
  let first;
  t.after(async () => {
    await first?.close();
    const resolved = realpathSync(dir);
    assert.equal(dirname(resolved), parent);
    assert.ok(basename(resolved).startsWith('bluesai-dot-task-'));
    rmSync(resolved, { recursive: true });
  });
  let now = Date.now(), store = new Store(path);
  let engine = new Engine(store, { configured: false }, {}, { now: () => now });
  const incoming = engine.receive({ text: '保留原有交接紀錄' });
  now += 30000;
  engine.checkDeadlines();
  const handoff = store.all('SELECT * FROM handoff_tasks');
  const window = store.all('SELECT * FROM response_windows');
  store.set('profile', { ...store.value('profile'), name: '保留商戶' });
  await engine.stop();
  // Build an actual v1 database, removing all later additive objects.
  store.db.exec(`DROP TABLE dot_tasks; DROP TABLE provider_receipts; DROP TABLE channel_activity;
    DROP TABLE web_chat_sessions; ALTER TABLE messages DROP COLUMN provider_instance;
    DELETE FROM schema_migrations WHERE version>=2`);
  store.close();
  first = await fixture(t, { path });
  assert.equal(first.store.value('profile').name, '保留商戶');
  assert.deepEqual(first.store.all('SELECT * FROM handoff_tasks'), handoff);
  assert.deepEqual(first.store.all('SELECT * FROM response_windows'), window);
  assert.equal(first.store.conversation(incoming.conversationId).state, 'waiting');
  const task = await create(first);
  const original = first.store.get('SELECT * FROM dot_tasks WHERE id=?', task.id);
  await first.close();
  const reopened = new Store(path);
  try {
    const rows = reopened.all('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows.map(x => x.version), [1, 2, 3, 4]);
    const persisted = reopened.get('SELECT * FROM dot_tasks WHERE id=?', task.id);
    assert.deepEqual(persisted, original);
    assert.deepEqual(reopened.all('SELECT * FROM handoff_tasks'), handoff);
    assert.deepEqual(reopened.all('SELECT * FROM response_windows'), window);
  } finally { reopened.close(); }
});
