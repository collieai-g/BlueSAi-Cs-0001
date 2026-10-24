import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const sample = (extra = {}) => ({
  id: 'selected-task', instruction: '檢查客服語氣', prompt: '已確認資料中的任務內容',
  verificationCode: 'association-code', version: 1, contextStale: false, status: 'prepared',
  revision: 1, snapshot: { profile: {}, facts: [] },
  ...extra,
});

const taskWithExpiry = expiresAt => sample({
  contextStale: false,
  snapshot: { profile: {}, facts: [{ id: 'approved-fact', title: '營業時間', content: '已核對安排', category: 'hours', expiresAt }] },
});

function targetFor(task, extra = {}) {
  return {
    value: task.prompt, isConnected: true, getClientRects: () => [{ width: 400, height: 150 }],
    focus() {}, select() {}, setSelectionRange() {}, ...extra,
  };
}

async function bridgeFixture({ native, host, clipboard = true, childFrame = false } = {}) {
  const requests = [], messages = [], copies = [], tools = new Map();
  const document = {};
  if (native !== undefined) document.oai = { annotation: { request(element, options) {
    requests.push({ element, options });
    return typeof native === 'function' ? native(element, options) : { accepted: native };
  } } };
  document.modelContext = { registerTool(tool) { tools.set(tool.name, tool); }, unregisterTool(name) { tools.delete(name); } };
  const navigator = {};
  if (clipboard) navigator.clipboard = { async writeText(text) { copies.push(text); } };
  const window = {};
  window.navigator = navigator;
  window.top = childFrame ? {} : window;
  window.self = window;
  if (host !== undefined) window.openai = { sendFollowUpMessage(input) {
    messages.push(input);
    return typeof host === 'function' ? host(input) : Promise.resolve(host);
  } };
  const code = await readFile(new URL('../public/agent-handoff.js', import.meta.url), 'utf8');
  runInNewContext(code, { window, document, navigator, console, Error, JSON, Promise, setTimeout, clearTimeout });
  assert.ok(window.csAgentBridge);
  return { bridge: window.csAgentBridge, requests, messages, copies, tools };
}

function selectedTaskCallbacks(initial = sample()) {
  let selected = initial;
  const rows = new Map([[initial.id, initial]]), reads = [], saves = [], errors = [];
  return {
    rows, reads, saves, errors,
    select(task) { selected = task; rows.set(task.id, task); },
    selected: () => selected,
    callbacks: {
      getSelectedTask: () => selected,
      async readTask(id) { reads.push(id); return rows.get(id); },
      async saveResult(id, expectedVersion, result) {
        // Preserve the real backend's authoritative version/context contract.
        const row = rows.get(id);
        if (!row || row.version !== expectedVersion || row.contextStale || ['cancelled', 'result_saved'].includes(row.status)) throw new Error('Task changed or ended');
        if (row.verificationCode !== result.verificationCode) throw new Error('Task association mismatch');
        saves.push({ id, expectedVersion, result });
        const task = { ...row, version: expectedVersion + 1, status: 'result_saved', resultText: result.text };
        rows.set(id, task);
        return task;
      },
      onError(error) { errors.push(error); },
    },
  };
}

function toolResult(result) {
  return result.content.map(item => item.text || '').join('\n');
}

test('native Agent handoff requests annotation synchronously and accepted confirms the request only', async () => {
  let inGesture = true;
  const f = await bridgeFixture({ native() { assert.equal(inGesture, true); return { accepted: true }; }, host: {} });
  const task = sample({ instruction: '長任務要求'.repeat(100) }), target = targetFor(task);
  const result = f.bridge.invoke(task, target);
  inGesture = false;
  assert.equal(f.requests.length, 1, 'request occurs before invoke returns');
  assert.equal(result.kind, 'annotation');
  assert.equal(result.accepted, true);
  assert.equal(f.requests[0].element, target);
  assert.equal(f.requests[0].options.mode, 'default');
  assert.equal(f.requests[0].options.metadata.taskId, task.id);
  assert.ok(f.requests[0].options.initialComment.length <= 240);
  assert.equal(f.messages.length, 0);
  assert.equal(f.copies.length, 0);
  assert.equal(task.status, 'prepared', 'native request acceptance does not mark a task submitted or completed');
});

test('native refusal never falls through to a different host or claims submission', async () => {
  const f = await bridgeFixture({ native: false, host: {} });
  const task = sample();
  const result = f.bridge.invoke(task, targetFor(task));
  assert.equal(result.kind, 'annotation');
  assert.equal(result.accepted, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.length, 0);
  assert.equal(f.copies.length, 0);
  assert.equal(task.status, 'prepared');
});

test('host follow-up runs only on explicit invocation and preserves its asynchronous outcome', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = await bridgeFixture({ host: () => pending });
  const selected = selectedTaskCallbacks();
  f.bridge.registerTools(selected.callbacks);
  assert.equal(f.messages.length, 0, 'loading and tool registration do not submit a task');
  const task = selected.selected(), result = f.bridge.invoke(task, targetFor(task));
  assert.equal(result.kind, 'host');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].prompt, task.prompt);
  assert.equal(task.status, 'prepared');
  finish({ acceptedByHost: true });
  await result.promise;
  assert.equal(task.status, 'prepared', 'host acceptance is not a DOT execution receipt');
  assert.equal(selected.saves.length, 0);
});

test('ordinary browser handoff falls back to copying the prepared task without claiming an AI call', async () => {
  const f = await bridgeFixture(), task = sample();
  assert.equal(f.copies.length, 0);
  const result = f.bridge.invoke(task, targetFor(task));
  assert.equal(result.kind, 'copy');
  await result.promise;
  assert.deepEqual(f.copies, [task.prompt]);
  assert.equal(f.messages.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(task.status, 'prepared');
});

test('clipboard refusal or unavailable access leaves task text selected and reports no successful copy', async () => {
  const f = await bridgeFixture({ clipboard: false }), task = sample();
  let selected = false;
  const result = f.bridge.invoke(task, targetFor(task, { select() { selected = true; } }));
  assert.equal(result.kind, 'copy');
  assert.equal(await result.promise, false);
  assert.equal(selected, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(task.status, 'prepared');
});

test('host refusal is preserved as a refused submission without changing the task ledger', async () => {
  const f = await bridgeFixture({ host: { accepted: false } }), task = sample();
  const result = f.bridge.invoke(task, targetFor(task));
  assert.equal(result.kind, 'host');
  assert.equal(await result.promise, false);
  assert.equal(task.status, 'prepared');
});

test('stale, terminal or unmounted task payloads cannot invoke the host', async () => {
  const f = await bridgeFixture({ native: true, host: {} });
  for (const task of [sample({ contextStale: true }), sample({ status: 'cancelled' }), sample({ status: 'result_saved' })]) {
    assert.throws(() => f.bridge.invoke(task, targetFor(task)));
  }
  const task = sample();
  for (const target of [targetFor(task, { isConnected: false }), targetFor(task, { getClientRects: () => [] }), targetFor(task, { value: '不同任務內容' })]) {
    assert.throws(() => f.bridge.invoke(task, target));
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.messages.length, 0);
});

test('cached task fact expiry is checked synchronously despite a previously fresh context flag', async () => {
  for (const options of [{ native: true }, { host: {} }, {}]) {
    const f = await bridgeFixture(options);
    const task = taskWithExpiry(Date.now() - 1);
    assert.equal(task.contextStale, false);
    assert.throws(() => f.bridge.invoke(task, targetFor(task)));
    assert.equal(f.requests.length, 0, 'expired content never reaches the native editor');
    assert.equal(f.messages.length, 0, 'expired content never reaches the host conversation');
    assert.equal(f.copies.length, 0, 'expired content is not exported through clipboard fallback');
  }
});

test('unexpired and non-expiring snapshot facts still allow the explicit native request', async () => {
  for (const expiresAt of [null, Date.now() + 60000]) {
    const f = await bridgeFixture({ native: true }), task = taskWithExpiry(expiresAt);
    assert.equal(f.bridge.invoke(task, targetFor(task)).accepted, true);
    assert.equal(f.requests.length, 1);
  }
});

test('direct copy refuses expired or missing snapshot metadata before disclosing task text', async () => {
  const f = await bridgeFixture();
  const expired = taskWithExpiry(Date.now() - 1);
  await assert.rejects(f.bridge.copy(targetFor(expired), expired));
  const missingSnapshot = sample();
  delete missingSnapshot.snapshot;
  await assert.rejects(f.bridge.copy(targetFor(missingSnapshot), missingSnapshot));
  assert.equal(f.copies.length, 0);
  const fresh = taskWithExpiry(Date.now() + 60000);
  assert.equal(await f.bridge.copy(targetFor(fresh), fresh), true);
  assert.deepEqual(f.copies, [fresh.prompt]);
});

test('WebMCP reads only the selected fresh task and refuses other, stale or terminal tasks', async () => {
  const f = await bridgeFixture(), state = selectedTaskCallbacks();
  f.bridge.registerTools(state.callbacks);
  const tool = f.tools.get('bluesai_get_task');
  assert.ok(tool);
  const rejected = await tool.execute({ taskId: 'another-task' });
  assert.equal(rejected.isError, true);
  assert.equal(state.reads.length, 0);
  const accepted = await tool.execute({ taskId: state.selected().id });
  assert.ok(!accepted.isError);
  assert.match(toolResult(accepted), /已確認資料中的任務內容/);
  assert.equal(state.saves.length, 0);
  for (const change of [{ contextStale: true }, { status: 'cancelled' }, { status: 'result_saved' }]) {
    state.rows.set(state.selected().id, { ...sample(), ...change });
    assert.equal((await tool.execute({ taskId: state.selected().id })).isError, true);
  }
});

test('WebMCP refuses a previously selected task if selection changes during its fresh read', async () => {
  const f = await bridgeFixture(), state = selectedTaskCallbacks();
  let finish;
  const original = state.selected();
  state.callbacks.readTask = () => new Promise(resolve => { finish = resolve; });
  f.bridge.registerTools(state.callbacks);
  const pending = f.tools.get('bluesai_get_task').execute({ taskId: original.id });
  state.select(sample({ id: 'new-selected-task', prompt: '新選擇的任務' }));
  finish(original);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.doesNotMatch(toolResult(result), /已確認資料中的任務內容/);
});

test('WebMCP will not expose a locally expired selected snapshot with an outdated fresh flag', async () => {
  const f = await bridgeFixture(), state = selectedTaskCallbacks(taskWithExpiry(Date.now() - 1));
  f.bridge.registerTools(state.callbacks);
  const result = await f.tools.get('bluesai_get_task').execute({ taskId: state.selected().id });
  assert.equal(result.isError, true);
  assert.doesNotMatch(toolResult(result), /已確認資料中的任務內容/);
  assert.equal(state.saves.length, 0);
});

test('WebMCP result saving enforces selection, current version and association before saving a draft', async () => {
  const f = await bridgeFixture(), state = selectedTaskCallbacks();
  f.bridge.registerTools(state.callbacks);
  const tool = f.tools.get('bluesai_save_task_result');
  assert.ok(tool);
  const task = state.selected(), input = { taskId: task.id, expectedVersion: task.version, verificationCode: task.verificationCode, text: '供商戶核對的建議' };
  for (const wrong of [{ taskId: 'another-task' }, { expectedVersion: task.version + 1 }, { verificationCode: 'wrong-code' }]) {
    assert.equal((await tool.execute({ ...input, ...wrong })).isError, true);
    assert.equal(state.saves.length, 0);
  }
  state.rows.set(task.id, { ...task, version: task.version + 1 });
  assert.equal((await tool.execute(input)).isError, true);
  assert.equal(state.saves.length, 0);
  for (const change of [{ contextStale: true }, { status: 'cancelled' }, { status: 'result_saved' }]) {
    state.rows.set(task.id, { ...task, ...change });
    assert.equal((await tool.execute(input)).isError, true);
    assert.equal(state.saves.length, 0);
  }
  state.rows.set(task.id, task);
  const result = await tool.execute(input);
  assert.ok(!result.isError);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].id, task.id);
  assert.equal(state.saves[0].expectedVersion, task.version);
  assert.equal(state.saves[0].result.text, input.text);
  assert.match(toolResult(result), /result_saved/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.requests.length, 0);
});

test('WebMCP task tools are not registered into a child frame', async () => {
  const f = await bridgeFixture({ childFrame: true });
  f.bridge.registerTools(selectedTaskCallbacks().callbacks);
  assert.equal(f.tools.size, 0);
});
