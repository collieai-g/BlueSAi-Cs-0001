import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution, normalizeEvent } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';

const SECRET = 'synthetic-webhook-secret-'.repeat(2);
const PROVIDER = { url: 'https://evolution.example.test', instance: 'test-instance', apiKey: 'synthetic-provider-key', deliveryEnabled: true };
const ADDRESS = '85255550123@s.whatsapp.net';
const incoming = (id = 'incoming-test') => ({ instance: PROVIDER.instance, event: 'messages.upsert', data: {
  key: { id, remoteJid: ADDRESS, fromMe: false }, message: { conversation: '營業時間？' }, messageTimestamp: Math.floor(Date.now() / 1000),
} });
const receipt = (status = 'DELIVERY_ACK', id = 'outbound-test', address = ADDRESS) => ({ instance: PROVIDER.instance, event: 'messages.update', data: {
  keyId: id, remoteJid: address, fromMe: true, status,
} });
function fixture(t, options = {}) {
  const store = new Store(options.path || ':memory:');
  const provider = options.provider || createEvolution({ ...PROVIDER, fetchImpl: async () => new Response(JSON.stringify({ key: { id: 'outbound-test' } })) });
  const engine = new Engine(store, options.agent || createAgent(), provider);
  const connections = createConnections({ engine, store, runtime: true, providerConfig: PROVIDER, publicBaseUrl: 'https://support.example.test', webhookSecret: SECRET, fetchImpl: options.fetchImpl });
  t.after(async () => { await engine.stop(); store.close(); });
  store.set('profile', { ...store.value('profile'), name: '合成測試商戶', service: '合成測試服務' });
  store.set('settings', { mode: 'review', handoffContact: '合成操作員' });
  store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', 'hours', '合成營業時間', 'hours', '測試時段十時至六時。', 1, null, Date.now());
  return { store, engine, connections };
}
async function httpFixture(t, options = {}) {
  const f = fixture(t, options);
  const server = createApp({ ...f, adminToken: 'synthetic-admin-token-'.repeat(2), webhookSecret: SECRET, activationAt: 0, workbench: f.connections, runtimeMode: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-admin-token-'.repeat(2) }) });
  const headers = { Origin: base, Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const call = async (path, method = 'GET', data) => {
    const response = await fetch(base + path, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const hook = payload => fetch(`${base}/webhooks/evolution`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(payload) });
  return { ...f, base, call, hook };
}

test('runtime uses one store for workbench, actual ingress, approval, provider acceptance and delivery', async t => {
  const f = await httpFixture(t);
  assert.equal((await fetch(f.base + '/workbench.html')).status, 200);
  assert.match(await (await fetch(f.base + '/console')).text(), /客戶對話/);
  assert.equal((await f.hook(incoming())).status, 200);
  assert.equal((await (await f.hook(incoming())).json()).duplicate, true);
  await f.engine.tick();
  const c = f.store.conversations()[0], m = f.store.messages(c.id).at(-1);
  assert.equal(m.status, 'draft');
  const state = await f.call('/api/workbench');
  assert.equal(state.data.connections.mode, 'runtime');
  assert.ok(state.data.connections.whatsapp.evidence.lastIncomingAt);
  assert.equal(state.data.knowledge[0].id, 'hours');
  assert.equal((await f.call(`/api/messages/${m.id}/approve`, 'POST', { text: '' })).status, 200);
  await f.engine.tick();
  assert.equal(f.store.messages(c.id).at(-1).status, 'accepted');
  assert.equal((await f.hook(receipt())).status, 200);
  assert.equal(f.store.messages(c.id).at(-1).status, 'delivered');
  assert.equal((await f.hook(receipt('READ'))).status, 200);
  assert.equal(f.store.messages(c.id).at(-1).status, 'read');
  assert.doesNotMatch(JSON.stringify((await f.call('/api/workbench')).data), /synthetic-provider-key|synthetic-webhook-secret/);
});

test('receipts are address and instance scoped, monotonic, deduplicated and never produce replies', async t => {
  const f = fixture(t);
  const c = f.engine.receive({ channel: 'evolution', address: ADDRESS, text: '人工' }).conversationId;
  f.engine.takeover(c);
  const id = f.engine.manualReply(c, '合成測試回覆');
  await f.engine.tick();
  const sendReceipt = (status, address = ADDRESS) => f.engine.recordReceipt(normalizeEvent(receipt(status, 'outbound-test', address), PROVIDER.instance).receipts[0]);
  assert.equal(sendReceipt('DELIVERY_ACK', '85255550999@s.whatsapp.net').matched, false);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', id).status, 'accepted');
  assert.throws(() => f.engine.recordReceipt({ instance: 'wrong-instance', providerId: 'outbound-test', address: ADDRESS, status: 'read' }));
  sendReceipt('READ'); sendReceipt('ERROR'); sendReceipt('DELIVERY_ACK'); sendReceipt('SERVER_ACK');
  assert.equal(sendReceipt('READ').duplicate, true);
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', id).status, 'read');
  assert.equal(f.store.messages(c).length, 2);
  assert.equal(f.store.all("SELECT * FROM messages WHERE status='queued'").length, 0);
});

test('receipt arriving before provider response is retained and reconciled after its ID is known', async t => {
  let resolveSend;
  const f = fixture(t, { provider: { ...PROVIDER, configured: true, send: () => new Promise(resolve => { resolveSend = resolve; }) } });
  const c = f.engine.receive({ channel: 'evolution', address: ADDRESS, text: '人工' }).conversationId;
  f.engine.takeover(c); const id = f.engine.manualReply(c, '合成回覆');
  const sending = f.engine.tick();
  assert.equal(f.engine.recordReceipt(normalizeEvent(receipt('READ'), PROVIDER.instance).receipts[0]).matched, false);
  resolveSend({ providerId: 'outbound-test' }); await sending;
  assert.equal(f.store.get('SELECT status FROM messages WHERE id=?', id).status, 'read');
});

test('receipt inbox and evidence survive restart without resending uncertain work', async t => {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'bluesai-receipt-')), path = join(dir, 'store.sqlite');
  t.after(() => { const full = realpathSync(dir); assert.equal(dirname(full), parent); assert.ok(basename(full).startsWith('bluesai-receipt-')); rmSync(full, { recursive: true, maxRetries: 5, retryDelay: 100 }); });
  let store = new Store(path), sends = 0;
  const provider = { ...PROVIDER, configured: true, async send() { sends++; return { providerId: 'outbound-test' }; } };
  let engine = new Engine(store, createAgent(), provider);
  const c = engine.receive({ channel: 'evolution', address: ADDRESS, text: '人工' }).conversationId;
  engine.takeover(c);
  const id = store.addMessage(c, 'staff', '重啟合成測試', { status: 'sending', providerId: 'outbound-test', providerInstance: PROVIDER.instance });
  engine.recordReceipt(normalizeEvent(receipt('DELIVERY_ACK'), PROVIDER.instance).receipts[0]);
  await engine.stop(); store.close();
  store = new Store(path); engine = new Engine(store, createAgent(), provider);
  try {
    await engine.tick();
    assert.equal(store.get('SELECT status FROM messages WHERE id=?', id).status, 'delivered');
    assert.ok(store.get('SELECT last_incoming_at,last_receipt_at FROM channel_activity').last_receipt_at);
    assert.equal(sends, 0);
    assert.deepEqual(store.all('SELECT version FROM schema_migrations').map(row => row.version), [1, 2, 3, 4, 5, 6, 7]);
  } finally { await engine.stop(); store.close(); }
});

test('webhook registration uses only configured callback and verifies readback without exposing secrets', async t => {
  let saved, calls = [];
  const f = fixture(t, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/webhook/set/')) { saved = JSON.parse(options.body).webhook; return new Response('{}'); }
    if (url.includes('/webhook/find/')) return new Response(JSON.stringify(saved || {}));
    return new Response(JSON.stringify({ instance: { state: 'open' } }));
  } });
  assert.equal(f.connections.status().whatsapp.status, 'configured');
  await f.connections.whatsapp({});
  assert.equal(f.connections.status().whatsapp.status, 'open');
  assert.equal((await f.connections.registerWebhook()).registered, true);
  assert.deepEqual(saved.events, ['MESSAGES_UPSERT', 'MESSAGES_UPDATE']);
  assert.equal(saved.url, 'https://support.example.test/webhooks/evolution');
  assert.equal(saved.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls.find(c => c.url.includes('/webhook/set/')).options.redirect, 'error');
  saved.headers.Authorization = 'wrong';
  assert.equal((await f.connections.checkWebhook()).registered, false);
  await assert.rejects(f.connections.whatsapp({ url: 'https://attacker.example.test' }), error => error.status === 409);
  await f.connections.clearWhatsApp();
  assert.equal(f.engine.evolution.configured, false);
  assert.equal(f.connections.status().whatsapp.receiveEnabled, false);
});

test('runtime webhook APIs require authenticated same-origin admin; malformed receipt cannot mutate messages', async t => {
  const f = await httpFixture(t);
  assert.equal((await fetch(f.base + '/api/workbench/connections/whatsapp-webhook', { method: 'POST' })).status, 401);
  assert.equal((await f.hook({ ...receipt(), instance: 'wrong' })).status, 400);
  assert.equal((await f.hook({ ...receipt(), data: { keyId: 'bad' } })).status, 400);
  assert.equal(f.store.all('SELECT * FROM provider_receipts').length, 0);
  assert.throws(() => createConnections({ engine: f.engine, store: f.store, runtime: true, publicBaseUrl: 'http://external.example.test' }), /PUBLIC_BASE/);
});

test('runtime configuration persists channel identity without credentials and reconnect never opens a disabled send gate', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const providerConfig = { ...PROVIDER, deliveryEnabled: false };
  const engine = new Engine(store, createAgent(), createEvolution(providerConfig));
  const connections = createConnections({ engine, store, runtime: true, providerConfig, fetchImpl: async () => new Response(JSON.stringify({ instance: { state: 'open' } })) });
  await connections.whatsapp({});
  assert.equal(engine.evolution.deliveryEnabled, false);
  const identity = store.get("SELECT value FROM config WHERE key='runtime_provider_identity'").value;
  assert.doesNotMatch(identity, /synthetic-provider-key/);
  assert.throws(() => createConnections({ engine, store, runtime: true, providerConfig: { ...providerConfig, instance: 'another-merchant' } }), /CHANNEL_IDENTITY_CHANGED/);
  assert.equal(connections.status().whatsapp.webhook.configured, false);
});

test('environment model credentials can be probed without returning them to the browser', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const engine = new Engine(store, createAgent({ apiKey: 'private-env-model-key', model: 'synthetic-model' }), createEvolution());
  const connections = createConnections({ engine, store, runtime: true, aiConfig: { apiKey: 'private-env-model-key', model: 'synthetic-model' }, fetchImpl: async () => new Response(JSON.stringify({
    status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ text: '你想了解甚麼？', decision: 'clarify', sourceIds: [] }) }] }],
  })) });
  assert.equal(connections.status().ai.status, 'configured');
  await connections.model({});
  assert.equal(connections.status().ai.status, 'connected');
  assert.doesNotMatch(JSON.stringify(connections.status()), /private-env-model-key/);
});
