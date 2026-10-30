import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createAgent } from '../src/agent.js';
import { createEvolution } from '../src/evolution.js';
import { createConnections } from '../src/connections.js';
import { createApp } from '../src/server.js';

const CARD = '/api/agents/bluesai-cs-0001';
const token = 'isolated-card-test-'.repeat(3);

function assertCardStylesScoped(input){
  const style=input.replace(/\/\*[\s\S]*?\*\//g,'');
  // Frame selectors are valid only inside a namespaced, structurally complete
  // animation. Strip those validated blocks before checking ordinary selectors.
  const ordinary=style.replace(/@keyframes\s+([\w-]+)\s*\{((?:\s*[^{}]+\{[^{}]*\})+\s*)\}/g,(_block,name,frames)=>{
    assert.match(name,/^bluesai-cs-[a-z0-9]+(?:-[a-z0-9]+)*$/,'animation name belongs to this product');
    for(const frame of frames.matchAll(/([^{}]+)\{[^{}]*\}/g))for(const value of frame[1].split(',')){
      const selector=value.trim();
      if(selector==='from'||selector==='to')continue;
      assert.match(selector,/^(?:\d+(?:\.\d+)?|\.\d+)%$/,'keyframe selector is a percentage, from or to');
      const percentage=Number(selector.slice(0,-1));
      assert.ok(percentage>=0&&percentage<=100,'keyframe percentage stays within its animation');
    }
    return '';
  });
  assert.doesNotMatch(ordinary,/@(?:-[\w]+-)?keyframes\b/,'unsupported or incomplete keyframes fail closed');
  for(const selectors of ordinary.matchAll(/(?:^|(?<=[{}]))\s*([^{}]+)\{/g)){
    if(selectors[1].startsWith('@'))continue;
    for(const selector of selectors[1].split(','))assert.match(selector.trim(),/^#cs-card-design(?:\s|[.#:[>+~]|$)/);
  }
}

test('CSS scope validation admits only product animations with valid frame selectors',()=>{
  assert.doesNotThrow(()=>assertCardStylesScoped('#cs-card-design .light{color:green}@keyframes bluesai-cs-synthetic{from{opacity:1}50%,100%{opacity:.5}to{opacity:1}}'));
  for(const css of [
    '@keyframes shared-animation{from{opacity:1}to{opacity:0}}',
    '@keyframes bluesai-cs-synthetic{body{opacity:1}}',
    '@keyframes bluesai-cs-synthetic{101%{opacity:1}}',
    '@keyframes bluesai-cs-synthetic{-1%{opacity:1}}',
    '@keyframes bluesai-cs-synthetic{from{.host{color:red}}}',
    '@media(min-width:1px){body{color:red}}',
    '50%{opacity:1}',
    '#cs-card-design .safe{color:green}.host{color:red}',
  ])assert.throws(()=>assertCardStylesScoped(css),undefined,css);
});

async function fixture(t) {
  const store = new Store(':memory:');
  // An offline, unstarted engine exercises local routes without any provider or phone.
  const engine = new Engine(store, createAgent(), createEvolution());
  const workbench = createConnections({ store, engine });
  const server = createApp({ store, engine, workbench, adminToken: token, sessionCookieName: 'bluesai_card_session' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await engine.stop(); store.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = async (origin = base) => fetch(base + CARD + '/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  const authorized = async () => {
    const response = await login();
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const call = async (tail, method = 'GET', input, extraHeaders = {}) => {
      const response = await fetch(base + CARD + tail, { method,
        headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...extraHeaders },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      return { status: response.status, data: await response.json() };
    };
    return { cookie, call };
  };
  return { base, store, engine, login, authorized };
}

test('default URL and former console URL open the single card without a cloned host shell', async t => {
  const { base } = await fixture(t);
  const first = await fetch(base + '/');
  assert.equal(first.status, 200);
  const html = await first.text();
  assert.match(html, /登入客服卡片/);
  assert.equal([...html.matchAll(/id="cs-card-design"/g)].length, 1);
  assert.match(html, /data-screen="list"/);
  assert.match(html, /data-screen="config"/);
  assert.match(html, /data-open-whatsapp/);
  // A semantic nav inside this card is allowed; the Studio's outer shell is not.
  assert.doesNotMatch(html, /class="[^"]*\b(?:bp-window|bp-side|bp-top)\b/);
  const old = await fetch(base + '/console', { redirect: 'manual' });
  assert.equal(old.status, 303);
  assert.equal(old.headers.get('location'), '/workbench.html');
  const redirected = await fetch(base + '/console');
  assert.equal(await redirected.text(), html);
});

test('canonical card routes require their own session and same-origin writes', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + CARD + '/state')).status, 401);
  assert.equal((await f.login('https://unrelated.test')).status, 403);
  const response = await f.login();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^bluesai_card_session=.+; HttpOnly; SameSite=Strict;/);
  const { cookie, call } = await f.authorized();
  const profile = { name: '卡片隔離測試', industry: '', service: '僅供測試的服務', instructions: '', tone: 'friendly' };
  const input = { profile, settings: { mode: 'review', handoffContact: '' } };
  assert.equal((await call('/profile', 'PUT', input, { Origin: 'https://unrelated.test' })).status, 403);
  assert.equal((await fetch(f.base + CARD + '/profile', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  assert.equal(f.store.value('profile').name, '');
  assert.equal((await call('/profile', 'PUT', input)).status, 200);
  const state = (await call('/state')).data;
  assert.deepEqual(state.profile, profile);
  assert.equal(state.settings.handoffContact, '', 'optional fields remain intentionally blank');
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token));
  assert.equal((await fetch(f.base + CARD + '/state', { headers: { Cookie: cookie.replace('bluesai_card_session', 'bp_session') } })).status, 401);
});

test('canonical memory and conversation actions touch only the supplied card store', async t => {
  const a = await fixture(t), b = await fixture(t);
  const { cookie, call } = await a.authorized(), other = await b.authorized();
  const untouched = (await other.call('/state')).data;
  assert.equal((await fetch(b.base + CARD + '/state', { headers: { Cookie: cookie } })).status, 401, 'another service cannot reuse the card session');
  assert.equal((await call('/training', 'POST', { text: '星期日休息。' })).status, 201);
  let state = (await call('/state')).data;
  assert.equal(state.knowledge.length, 1);
  const id = state.knowledge[0].id;
  assert.equal(state.knowledge[0].approved, 0);
  assert.equal((await call('/knowledge/' + id, 'POST', {})).status, 200);
  assert.equal(a.store.facts()[0].id, id);
  assert.equal((await call('/knowledge/' + id, 'PUT', { content: '星期日十時開門。' })).status, 200);
  assert.equal(a.store.facts().length, 0, 'editing invalidates previous approval');
  assert.equal((await call('/knowledge/' + id, 'DELETE')).status, 200);

  // This is a local route fixture, never a claim that a WhatsApp phone was connected.
  const { conversationId } = a.engine.receive({ channel: 'demo', address: 'isolated-test-customer', text: '測試訊息', review: true });
  const list = (await call('/conversations')).data.conversations;
  assert.deepEqual(list.map(c => c.id), [conversationId]);
  assert.equal((await call('/conversations/' + conversationId)).data.messages[0].content, '測試訊息');
  assert.equal((await call('/conversations/' + conversationId + '/takeover', 'POST', {})).status, 200);
  assert.equal(a.store.conversation(conversationId).state, 'human');
  assert.equal((await call('/conversations/' + conversationId + '/reply', 'POST', { text: '人工測試回覆' })).status, 201);
  assert.equal(a.store.messages(conversationId).at(-1).status, 'queued');
  assert.equal((await call('/conversations/' + conversationId + '/resume', 'POST', {})).status, 200);
  assert.equal(a.store.conversation(conversationId).state, 'ai');
  assert.deepEqual((await other.call('/state')).data, untouched);
  assert.deepEqual((await other.call('/conversations')).data.conversations, []);
});

test('host overview, work and data paths have no writable canonical route', async t => {
  const f = await fixture(t), { call } = await f.authorized();
  const before = (await call('/state')).data;
  for (const path of ['/overview', '/work', '/data', '/host/state', '/settings']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await call(path, method, { overwritten: true })).status, 404, method + ' ' + path);
    }
  }
  assert.deepEqual((await call('/state')).data, before);
});

test('card source scopes styling, icons and API access without host navigation or state writes', async () => {
  const source = await readFile(new URL('../design/customer-agent-card-design.html', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/workbench.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/workbench.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../public/workbench-api.js', import.meta.url), 'utf8');
  for (const value of [source, html, js, api]) {
    assert.doesNotMatch(value, /\/(?:console)(?:[/'"?#]|$)/);
    assert.doesNotMatch(value, /(?:setWidgetState|openai:set_globals|window\.csBackend)/);
    assert.doesNotMatch(value, /['"]\/api\/(?:state|profile|settings|knowledge|conversations|messages|workbench)(?:[/'"]|$)/);
  }
  assert.doesNotMatch(source + html, /class="[^"]*\b(?:bp-window|bp-side|bp-top)\b/);
  assert.match(api, /const BASE=['"]\/api\/agents\/bluesai-cs-0001['"]/);
  assert.match(api, /fetch\(BASE\+path/);
  assert.match(js, /cardRoot\.querySelectorAll\('\[data-lucide\]'\)/);
  assert.doesNotMatch(js, /document\.querySelectorAll\(/);
  assertCardStylesScoped(source.match(/<style>([\s\S]*?)<\/style>/)[1]);
});

test('component export and asset allowlist exclude standalone login, global CSS and diagnostic shells', async () => {
  // Match Python's universal-newline source and generated-asset reads, retaining full-content comparisons.
  const source = (await readFile(new URL('../design/customer-agent-card-design.html', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const component = (await readFile(new URL('../public/agent-card.html', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const css = (await readFile(new URL('../public/agent-card.css', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const manifest = JSON.parse(await readFile(new URL('../integrations/blueprint/card-ui.json', import.meta.url), 'utf8'));
  assert.equal(component, source.replace(/<(?:style|script)>[\s\S]*?<\/(?:style|script)>/g, '')
    .replace(/^[ \t]+$/gm, '').replace('id="cs-card-design"', 'id="cs-card-design" hidden'));
  assert.doesNotMatch(component, /<!doctype|<(?:html|head|body|style|script)\b|data-local-login|local-login/i);
  assert.equal([...component.matchAll(/id="cs-card-design"/g)].length, 1);
  assert.equal(css, source.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/^[ \t]+$/gm, ''));
  assert.doesNotMatch(css, /(?:^|[{},])\s*(?:body|html|:root|\.local-login)(?:[\s.#:[>{,]|$)/m);
  assert.equal(manifest.status, 'requires_setup');
  assert.equal(manifest.required_renderer, 'bluesai-management/1');
  assert.equal(manifest.required_api, 'bluesai-management-api/1');
  assert.equal(manifest.api_namespace, CARD);
  assert.equal(manifest.root_selector, '#cs-card-design');
  assert.equal(manifest.item_count, 1);
  assert.equal(manifest.host_rules.native_renderer_required, true);
  assert.equal(manifest.host_rules.raw_html_or_script_injection, 'forbidden');
  assert.equal(manifest.host_rules.private_host_installation, 'not_verified');
  assert.deepEqual(manifest.asset_allowlist, [manifest.assets.markup, manifest.assets.stylesheet, ...manifest.assets.scripts_in_order]);
  assert.deepEqual(manifest.forbidden_host_bundle_assets, [
    'public/index.html', 'public/app.js', 'public/style.css', 'public/workbench.html', 'public/workbench.css',
  ]);
  for (const asset of manifest.asset_allowlist) {
    assert.ok(!manifest.forbidden_host_bundle_assets.includes(asset));
    assert.ok((await readFile(new URL('../' + asset, import.meta.url), 'utf8')).length > 0, asset);
  }
});


test('expanded card keeps a ratio frame and both working regions at every width',async()=>{
  const source=await readFile(new URL('../design/customer-agent-card-design.html',import.meta.url),'utf8');
  const style=source.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(style,/\.bp-config-card\{[^}]*aspect-ratio:4\/3/);
  assert.match(style,/grid-template-columns:clamp\(176px,28%,288px\) minmax\(0,1fr\)/);
  assert.match(style,/grid-template-columns:clamp\(144px,20%,208px\) minmax\(0,1fr\)/);
  assert.match(style,/\[data-screen="config"\]\{[^}]*min-width:576px/);
  assert.doesNotMatch(style,/(?:100(?:d|s|l)?vh|data-mobile-pane|\.bp-management-workspace\{display:flex;flex-direction:column)/);
  assert.doesNotMatch(source,/mobileList|data-queue-back|data-mobile-pane/);
  const nativeCss=await readFile(new URL('../integrations/blueprint/native/host-bounds.css',import.meta.url),'utf8');
  assert.match(nativeCss,/\.bluesai-native-card\[data-bluesai-mode="expanded"\] #cs-card-design \.bp-card-surface\{[^}]*padding:0/,
    'native frame clears host main padding inside its own expanded card only');
  assertCardStylesScoped(style);
});
