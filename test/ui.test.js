import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createApp } from '../src/server.js';

test('vendored Studio assets retain their pinned source content and license', async () => {
  const provenance = JSON.parse(await readFile(new URL('../UI_SOURCE.json', import.meta.url), 'utf8'));
  for (const item of provenance.copiedFiles) {
    // Git may check text out as CRLF on Windows; compare the documented LF form.
    const content = (await readFile(new URL('../' + item.path, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(content).digest('hex'), item.sha256, item.path);
  }
});

test('all login shell assets load locally with correct MIME, without exposing private files', async t => {
  const store = new Store(':memory:');
  const engine = new Engine(store, createAgent(), createEvolution());
  const server = createApp({store, engine, adminToken:'a'.repeat(32)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await engine.stop(); store.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const html = await (await fetch(base)).text();
  assert.match(html, /登入客服卡片/);
  assert.match(html, /id="cs-card-design"/);
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(match => match[1]))];
  assert.ok(assets.length > 0);
  for (const path of assets) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const mime = path === '/chat' || path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript';
    assert.ok(response.headers.get('content-type').startsWith(mime), path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    assert.ok((await response.text()).length > 0, path);
  }
  for (const path of ['/agent.json', '/.env', '/src/store.js', '/vendor/LICENSE.blueprint', '/vendor/../agent.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal(store.value('profile').name, '');
  assert.equal(store.facts().length, 0);
});
