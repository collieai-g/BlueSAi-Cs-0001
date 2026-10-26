import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const instance = 'synthetic-self-reply-instance';
const address = '85255550111@s.whatsapp.net';
const grantId = 'synthetic-self-grant-0001';
const nextGrantId = 'synthetic-self-grant-0002';

function fixture(t, { enabled = true, automaticKnowledge = true, send } = {}) {
  const store = new Store(':memory:');
  let now = Date.now(), eventNumber = 0, modelCalls = 0, externalSends = 0;
  const sent = [];
  const engine = new Engine(store, {
    configured: true,
    async reply() { modelCalls++; throw new Error('Self tests must not invoke an AI adapter'); },
  }, {
    configured: true, deliveryEnabled: false, instance,
    async send() { externalSends++; throw new Error('Self tests must not use ordinary customer sending'); },
  }, { now: () => now });
  engine.configureInbox({ enabled, automaticKnowledge, aiFallback: enabled, automaticAi: enabled });
  const sender = async input => {
    sent.push({ ...input });
    return send ? send(input, sent.length) : { providerId: 'synthetic-self-output-' + sent.length };
  };
  t.after(async () => { await engine.stop(); store.close(); });
  return {
    store, engine, sent,
    now: () => now,
    advance: milliseconds => { now += milliseconds; },
    calls: () => ({ modelCalls, externalSends }),
    enable: (scope = {}) => engine.setSelfTestReplyScope({ available: true, enabled: true, automaticFaq: true, grantId, ...scope }, sender),
    revoke: () => engine.setSelfTestReplyScope({ available: true, enabled: false, automaticFaq: false }),
    incoming: (text = 'Hello', extra = {}) => engine.receiveSelfTest({ address, eventId: 'synthetic-self-input-' + ++eventNumber, text, timestamp: now, ...extra }),
    rawMessage: id => store.get('SELECT * FROM messages WHERE id=?', id),
  };
}

function customerWorkStaysEmpty(f) {
  for (const table of ['jobs', 'response_windows', 'handoff_tasks', 'channel_activity']) {
    assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(f.engine.inboxStatus().pendingCount, 0);
  assert.deepEqual(f.calls(), { modelCalls: 0, externalSends: 0 });
}

function approvedHello(f) {
  return f.engine.addFaq({ question: 'Hello', answer: '［合成測試］你好。', approved: true });
}

test('self messages stay read-only by default despite enabled AI and a claimed grant', async t => {
  const f = fixture(t); approvedHello(f);
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const c = f.store.conversation(received.conversationId);
  assert.equal(c.channel, 'whatsapp_self_test');
  assert.equal(c.state, 'self_test');
  assert.equal(received.customerAcceptance, false);
  assert.equal(f.engine.selfTestReplyStatus(c).eligible, false);
  assert.deepEqual(f.store.messages(c.id).map(m => m.role), ['user']);
  assert.throws(() => f.engine.manualSelfTestReply(c.id, { text: '不應發送', operationId: 'default-manual-0001', expectedVersion: c.version }), { status: 409 });
  assert.throws(() => f.engine.takeover(c.id, 'ai'), { status: 409 });
  await f.engine.tick();
  assert.equal(f.sent.length, 0);
  customerWorkStaysEmpty(f);
});

test('enabling a grant never replays an old Hello and requires a newly granted input', async t => {
  const f = fixture(t); approvedHello(f);
  const old = f.incoming('Hello', { eventId: 'old-hello-before-opt-in' });
  f.enable();
  await f.engine.tick();
  assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(old.conversationId)).eligible, false);
  assert.equal(f.incoming('Hello', { eventId: 'old-hello-before-opt-in', replyGrantId: grantId }).duplicate, true);
  assert.equal(f.store.messages(old.conversationId).length, 1);
  assert.throws(() => f.engine.manualSelfTestReply(old.conversationId, { text: '舊訊息不能回覆', operationId: 'old-manual-0001', expectedVersion: f.store.conversation(old.conversationId).version }), { status: 409 });
  for (const replyGrantId of [undefined, nextGrantId]) {
    const received = f.incoming('Hello', { replyGrantId });
    assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(received.conversationId)).eligible, false);
    assert.equal(f.store.messages(received.conversationId).filter(m => m.role === 'assistant').length, 0);
  }
  const received = f.incoming('Hello', { replyGrantId: grantId });
  assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(received.conversationId)).eligible, true);
  assert.equal(f.store.conversation(received.conversationId).state, 'self_auto');
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].replyToId, f.rawMessage(received.messageId).provider_id);
  customerWorkStaysEmpty(f);
});

test('one exact approved FAQ is sent once per new input without any model or customer sender', async t => {
  const f = fixture(t), rule = approvedHello(f); f.enable();
  const event = { eventId: 'exact-self-hello', replyGrantId: grantId };
  const received = f.incoming('  ＨＥＬＬＯ？ ', event);
  const c = f.store.conversation(received.conversationId);
  const answer = f.store.messages(c.id).at(-1);
  assert.equal(answer.role, 'assistant');
  assert.equal(answer.status, 'queued');
  assert.equal(answer.engine, 'self-test-knowledge');
  assert.deepEqual(answer.sources, [rule.knowledgeId]);
  f.engine.answerSelfTest(c, received.messageId);
  assert.equal(f.incoming('  ＨＥＬＬＯ？ ', event).duplicate, true);
  assert.equal(f.store.messages(c.id).filter(m => m.role === 'assistant').length, 1);
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { text: rule.answer, grantId, replyToId: event.eventId, operationId: 'self-faq-' + received.messageId, linkPreview: false });
  assert.equal(f.rawMessage(answer.id).status, 'accepted');
  f.engine.answerSelfTest(f.store.conversation(c.id), received.messageId);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  customerWorkStaysEmpty(f);
});

test('self FAQ automation requires both self options and both existing global FAQ permissions', async t => {
  for (const setting of [
    { name: 'self automatic FAQ off', self: { automaticFaq: false } },
    { name: 'global FAQ off', policy: { enabled: false, automaticKnowledge: true } },
    { name: 'global automatic answer off', policy: { enabled: true, automaticKnowledge: false } },
  ]) {
    await t.test(setting.name, async t => {
      const f = fixture(t, setting.policy); approvedHello(f); f.enable(setting.self);
      const received = f.incoming('Hello', { replyGrantId: grantId });
      assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(received.conversationId)).eligible, true);
      await f.engine.tick();
      assert.deepEqual(f.store.messages(received.conversationId).map(m => m.role), ['user']);
      assert.equal(f.sent.length, 0);
      customerWorkStaysEmpty(f);
    });
  }
});

test('manual self reply atomically takes control and operation IDs do not send twice', async t => {
  const f = fixture(t); approvedHello(f); f.enable();
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const faq = f.store.messages(received.conversationId).at(-1);
  const input = { text: '［合成測試］本人回覆。', operationId: 'manual-idempotent-0001', expectedVersion: f.store.conversation(received.conversationId).version };
  const first = f.engine.manualSelfTestReply(received.conversationId, input);
  assert.equal(first.status, 'queued'); assert.equal(first.sent, false);
  assert.equal(f.store.conversation(received.conversationId).state, 'self_human');
  assert.equal(f.rawMessage(faq.id).status, 'cancelled');
  assert.deepEqual(f.engine.manualSelfTestReply(received.conversationId, input), first);
  assert.throws(() => f.engine.manualSelfTestReply(received.conversationId, { ...input, text: '不同內容' }), { status: 409 });
  assert.throws(() => f.engine.manualSelfTestReply(received.conversationId, { ...input, operationId: 'manual-stale-version-0002' }), { status: 409 });
  assert.equal(f.store.messages(received.conversationId).filter(m => m.role === 'staff').length, 1);
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, input.text);
  assert.equal(f.sent[0].replyToId, f.rawMessage(received.messageId).provider_id);
  assert.equal(f.sent[0].operationId, input.operationId);
  assert.equal(f.engine.manualSelfTestReply(received.conversationId, input).sent, true);
  await f.engine.tick(); assert.equal(f.sent.length, 1);
  customerWorkStaysEmpty(f);
});

test('revoking or replacing a grant cancels queued manual work and requires another new input', async t => {
  const f = fixture(t); f.enable({ automaticFaq: false });
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const input = { text: '［合成測試］撤銷前的回覆。', operationId: 'manual-before-revoke-0001', expectedVersion: f.store.conversation(received.conversationId).version };
  const queued = f.engine.manualSelfTestReply(received.conversationId, input);
  f.revoke();
  assert.equal(f.rawMessage(queued.messageId).status, 'cancelled');
  assert.equal(f.engine.manualSelfTestReply(received.conversationId, input).status, 'cancelled');
  assert.throws(() => f.engine.manualSelfTestReply(received.conversationId, { ...input, operationId: 'manual-after-revoke-0002', expectedVersion: f.store.conversation(received.conversationId).version }), { status: 409 });
  f.enable({ automaticFaq: false, grantId: nextGrantId });
  assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(received.conversationId)).eligible, false);
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  f.incoming('新測試', { replyGrantId: grantId });
  assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(received.conversationId)).eligible, false);
  const next = f.incoming('新測試', { replyGrantId: nextGrantId });
  f.engine.manualSelfTestReply(next.conversationId, { text: '［合成測試］新授權回覆。', operationId: 'manual-new-grant-0003', expectedVersion: f.store.conversation(next.conversationId).version });
  await f.engine.tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].grantId, nextGrantId);
  customerWorkStaysEmpty(f);
});

test('manual control survives new input and resume processes only the next new message', async t => {
  const f = fixture(t); approvedHello(f); f.enable();
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const manual = f.engine.manualSelfTestReply(received.conversationId, { text: '［合成測試］人工核對中。', operationId: 'manual-control-0001', expectedVersion: f.store.conversation(received.conversationId).version });
  f.incoming('Hello', { replyGrantId: grantId });
  assert.equal(f.rawMessage(manual.messageId).status, 'cancelled');
  assert.equal(f.store.conversation(received.conversationId).state, 'self_human');
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  const before = f.store.messages(received.conversationId).length;
  f.engine.takeover(received.conversationId, 'ai');
  assert.equal(f.store.conversation(received.conversationId).state, 'self_auto');
  await f.engine.tick();
  assert.equal(f.store.messages(received.conversationId).length, before);
  assert.equal(f.sent.length, 0);
  f.incoming('Hello', { replyGrantId: grantId });
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  customerWorkStaysEmpty(f);
});

test('unapproved, expired, conflicting, refund and unmatched self questions never call AI or send', async t => {
  for (const scenario of ['unapproved', 'expired', 'conflict', 'refund-question', 'refund-category', 'unmatched']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      const rule = f.engine.addFaq({ question: scenario === 'refund-question' ? '可以退款嗎' : 'Hello', answer: '［合成測試］待核對答案。', approved: scenario !== 'unapproved' });
      if (scenario === 'expired') f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?', f.now() - 1, rule.knowledgeId);
      if (scenario === 'conflict') f.engine.addFaq({ question: 'Hello', answer: '［合成測試］另一個答案。', approved: true });
      if (scenario === 'refund-category') f.store.run("UPDATE knowledge SET category='refund' WHERE id=?", rule.knowledgeId);
      f.enable();
      const received = f.incoming(scenario === 'refund-question' ? '可以退款嗎' : scenario === 'unmatched' ? 'Hello，另外一個問題' : 'Hello', { replyGrantId: grantId });
      await f.engine.tick();
      assert.deepEqual(f.store.messages(received.conversationId).map(m => m.role), ['user']);
      assert.equal(f.sent.length, 0);
      customerWorkStaysEmpty(f);
    });
  }
});

test('FAQ source approval, expiry and refund category are rechecked before self dispatch', async t => {
  for (const change of ['approval', 'expiry', 'refund']) {
    await t.test(change, async t => {
      const f = fixture(t), rule = approvedHello(f); f.enable();
      const received = f.incoming('Hello', { replyGrantId: grantId });
      const answer = f.store.messages(received.conversationId).at(-1);
      assert.equal(answer.status, 'queued');
      if (change === 'approval') f.store.run('UPDATE knowledge SET approved=0 WHERE id=?', rule.knowledgeId);
      if (change === 'expiry') f.store.run('UPDATE knowledge SET expires_at=? WHERE id=?', f.now() - 1, rule.knowledgeId);
      if (change === 'refund') f.store.run("UPDATE knowledge SET category='refund' WHERE id=?", rule.knowledgeId);
      await f.engine.tick();
      assert.equal(f.rawMessage(answer.id).status, 'cancelled');
      assert.equal(f.sent.length, 0);
      customerWorkStaysEmpty(f);
    });
  }
});

test('unknown self send outcome disables the grant and never retries the same work', async t => {
  const f = fixture(t, { send: async () => { throw new Error('synthetic provider timeout'); } });
  approvedHello(f); f.enable();
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const answer = f.store.messages(received.conversationId).at(-1);
  await f.engine.tick();
  assert.equal(f.rawMessage(answer.id).status, 'uncertain');
  assert.equal(f.engine.selfReply.enabled, false);
  assert.equal(f.engine.selfReply.grantId, null);
  await f.engine.tick();
  f.incoming('Hello', { replyGrantId: grantId });
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  customerWorkStaysEmpty(f);
});

test('self receipts reconcile monotonically without contributing customer channel activity', async t => {
  let resolveSend;
  const f = fixture(t, { send: () => new Promise(resolve => { resolveSend = resolve; }) });
  approvedHello(f); f.enable();
  const received = f.incoming('Hello', { replyGrantId: grantId });
  const answer = f.store.messages(received.conversationId).at(-1);
  const sending = f.engine.tick();
  const receipt = status => ({ instance, providerId: 'synthetic-delayed-self-output', address, status, selfTest: true });
  try {
    assert.equal(f.engine.recordReceipt(receipt('read')).matched, false);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM channel_activity').n, 0);
  } finally {
    resolveSend({ providerId: 'synthetic-delayed-self-output' });
    await sending;
  }
  assert.equal(f.rawMessage(answer.id).status, 'read');
  assert.equal(f.engine.recordReceipt(receipt('read')).duplicate, true);
  f.engine.recordReceipt(receipt('accepted'));
  f.engine.recordReceipt({ ...receipt('delivered'), selfTest: false });
  assert.equal(f.rawMessage(answer.id).status, 'read');
  assert.equal(f.store.messages(received.conversationId).length, 2);
  assert.equal(f.sent.length, 1);
  customerWorkStaysEmpty(f);
});

test('failed scope audit rolls back storage and never enables an in-memory self grant', async t => {
  const f = fixture(t); approvedHello(f);
  const old = f.incoming('Hello');
  const before = f.store.conversation(old.conversationId);
  const originalAudit = f.store.audit;
  f.store.audit = function(action, target) {
    if (action === 'self_test_reply_scope_changed') throw new Error('synthetic scope audit failure');
    return originalAudit.call(this, action, target);
  };
  try {
    assert.throws(() => f.enable(), /synthetic scope audit failure/);
  } finally {
    f.store.audit = originalAudit;
  }
  assert.deepEqual(f.engine.selfReply, { available: false, enabled: false, automaticFaq: false, grantId: null, requiresNewMessage: true });
  assert.equal(f.engine.selfReplySender, null);
  assert.deepEqual(f.store.conversation(old.conversationId), before);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM audit WHERE action='self_test_reply_scope_changed'").n, 0);
  const next = f.incoming('Hello', { replyGrantId: grantId });
  assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(next.conversationId)).eligible, false);
  await f.engine.tick();
  assert.equal(f.sent.length, 0);
  customerWorkStaysEmpty(f);
});

test('a late rejection from revoked grant A cannot disable newly granted B or its new Hello', async t => {
  let rejectOldSend;
  const f = fixture(t, { send: (input, number) => number === 1
    ? new Promise((resolve, reject) => { rejectOldSend = reject; })
    : { providerId: 'synthetic-new-grant-output' } });
  approvedHello(f); f.enable();
  const first = f.incoming('Hello', { replyGrantId: grantId });
  const oldAnswer = f.store.messages(first.conversationId).at(-1);
  const oldSending = f.engine.tick();
  let newAnswer;
  try {
    assert.equal(f.rawMessage(oldAnswer.id).status, 'sending');
    assert.equal(typeof rejectOldSend, 'function');
    f.revoke();
    f.enable({ grantId: nextGrantId });
    const next = f.incoming('Hello', { replyGrantId: nextGrantId });
    newAnswer = f.store.messages(next.conversationId).at(-1);
    assert.equal(newAnswer.status, 'queued');
    assert.equal(f.engine.selfTestReplyStatus(f.store.conversation(next.conversationId)).eligible, true);
  } finally {
    rejectOldSend?.(new Error('synthetic late failure from grant A'));
    await oldSending;
  }
  assert.equal(f.rawMessage(oldAnswer.id).status, 'uncertain');
  assert.equal(f.engine.selfReply.enabled, true);
  assert.equal(f.engine.selfReply.grantId, nextGrantId);
  assert.equal(f.rawMessage(newAnswer.id).status, 'queued');
  await f.engine.tick();
  assert.equal(f.rawMessage(newAnswer.id).status, 'accepted');
  assert.deepEqual(f.sent.map(input => input.grantId), [grantId, nextGrantId]);
  assert.equal(f.engine.selfReply.enabled, true);
  customerWorkStaysEmpty(f);
});

test('a valid self Hello timestamp ten seconds ahead is clamped and immediately queues its FAQ', async t => {
  const f = fixture(t); approvedHello(f); f.enable();
  const received = f.incoming('Hello', { replyGrantId: grantId, timestamp: f.now() + 10000 });
  const conversation = f.store.conversation(received.conversationId);
  assert.equal(conversation.last_customer_at, f.now());
  assert.equal(conversation.state, 'self_auto');
  assert.equal(f.engine.selfTestReplyStatus(conversation).eligible, true);
  const answer = f.store.messages(conversation.id).at(-1);
  assert.equal(answer.role, 'assistant');
  assert.equal(answer.status, 'queued');
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.rawMessage(answer.id).status, 'accepted');
  customerWorkStaysEmpty(f);
});
