import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { createAgent } from './agent.js';
import { createEvolution } from './evolution.js';
import { Engine } from './engine.js';
import { createApp } from './server.js';
import { createConnections } from './connections.js';
import identity from '../agent.json' with { type: 'json' };

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 22) throw new Error('請使用 Node.js 24.22 或更新的 24.x 版本。');
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root,'.env'))) process.loadEnvFile(resolve(root,'.env'));
const env = process.env;
const dataDir = resolve(env.BLUEPRINT_DATA_DIR || resolve(homedir(), '.blueprint-service'));
const rel = relative(root, dataDir);
if (!(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) throw new Error('BLUEPRINT_DATA_DIR 必須在程式碼倉庫之外。');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// One process owns this SQLite store. After an abnormal exit, inspect the recorded
// PID before manually removing the lock; do not guess whether another worker lives.
const lockPath = resolve(dataDir, 'service.lock');
let lock;
try { lock = openSync(lockPath,'wx',0o600); writeFileSync(lock,String(process.pid)); }
catch { throw new Error(`資料目錄已鎖定。請先停止另一個服務；如曾異常退出，核對 ${lockPath} 的 PID 後才移除鎖檔。`); }
let store, engine, server;
try {
  const tokenPath = resolve(dataDir,'admin-token');
  let token = env.ADMIN_TOKEN;
  if (!token) {
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    token = readFileSync(tokenPath,'utf8').trim();
  }
  store = new Store(resolve(dataDir,'service.sqlite'));
  const agent = createAgent({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
  const providerConfig = { url: env.EVOLUTION_URL, instance: env.EVOLUTION_INSTANCE, apiKey: env.EVOLUTION_API_KEY, deliveryEnabled: env.DELIVERY_ENABLED === 'true' };
  const evolution = createEvolution(providerConfig);
  engine = new Engine(store, agent, evolution);
  const connections = createConnections({ engine, store, runtime: true, providerConfig,
    aiConfig: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }, publicBaseUrl: env.PUBLIC_BASE_URL, webhookSecret: env.WEBHOOK_SECRET });
  server = createApp({ store, engine, adminToken: token, webhookSecret: env.WEBHOOK_SECRET, cookieSecure: env.COOKIE_SECURE === 'true', workbench: connections, runtimeMode: true, webChatEnabled: env.WEB_CHAT_ENABLED === 'true' });
  const port = Number(env.PORT || 3100); const host = env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 不正確。');
  server.listen(port, host, () => {
    engine.start();
    console.log(`${identity.name} (${identity.id})：http://${host}:${port}`);
    console.log(`同一客服資料及執行器的設定入口：http://${host}:${port}/workbench.html`);
    console.log(env.ADMIN_TOKEN ? '請使用你設定的 ADMIN_TOKEN 登入。' : `管理員密碼保存在 ${tokenPath}；請在本機讀取，勿貼到聊天或提交至 Git。`);
    console.log(agent.configured ? 'AI：已設定 OpenAI（尚未驗證帳戶連線）。' : 'AI：離線示範模式，未連接語言模型。');
    console.log(evolution.deliveryEnabled ? '真實發送開關已開啟；仍需完成介面設定。' : '真實發送已關閉。');
  });
  let closing = false;
  async function shutdown() {
    if (closing) return; closing = true;
    await new Promise(resolve => server.close(resolve));
    await engine.stop(); store.close(); closeSync(lock); unlinkSync(lockPath);
  }
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
  server.on('error', async () => { console.error('無法啟動伺服器，請檢查連接埠。'); await engine.stop(); store.close(); closeSync(lock); unlinkSync(lockPath); process.exitCode = 1; });
} catch (error) {
  store?.close(); closeSync(lock); unlinkSync(lockPath); throw error;
}
