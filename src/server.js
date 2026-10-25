import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ServiceError } from './engine.js';
import { normalizeEvent } from './evolution.js';
import { createDotTasks } from './dot-tasks.js';
import { createWebChat } from './web-chat.js';
import { createInboxContext } from './inbox-context.js';
import identity from '../agent.json' with { type: 'json' };

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const string = (value, max = 4000, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ServiceError('請填寫有效內容。');
  return value.trim();
};
const choice = (value, choices) => { if (!choices.includes(value)) throw new ServiceError('設定值不正確。'); return value; };
async function body(req) {
  let size = 0; const chunks = [];
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ServiceError('需要 JSON 格式。', 415);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new ServiceError('內容太長。', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new ServiceError('JSON 內容不正確。'); }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }

export function createApp({ store, engine, adminToken, webhookSecret = '', cookieSecure = false, activationAt = Date.now(), workbench = null, sessionCookieName = 'bp_session', runtimeMode = false, webChatEnabled = false }) {
  if (adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters');
  if (webhookSecret && webhookSecret.length < 32) throw new Error('WEBHOOK_SECRET must contain at least 32 characters');
  const sessions = new Map(); const failures = new Map();
  const dotTasks = workbench ? createDotTasks(store) : null;
  const inboxContext = workbench ? createInboxContext({store,engine}) : null;
  const eventStreams = new Set();
  engine.webChatEnabled = webChatEnabled;
  const webChat = createWebChat({ store, engine, cookieSecure, enabled: webChatEnabled });
  if(!/^[a-zA-Z0-9_]+$/.test(sessionCookieName))throw new Error('Invalid cookie name');
  const cookie = (value, age) => `${sessionCookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${cookieSecure ? '; Secure' : ''}`;
  const runtime = () => ({ agent: engine.agent.configured ? 'openai' : 'offline', evolutionConfigured: engine.evolution.configured,
    deliveryEnabled: engine.evolution.deliveryEnabled, liveReady: engine.liveReady(), webhookConfigured: Boolean(webhookSecret) });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const requestedPath = new URL(req.url, 'http://localhost').pathname;
      // Only this service's card namespace is dispatched here. Host routes and
      // host storage are never mounted or replaced by this server.
      const cardBase = '/api/agents/bluesai-cs-0001';
      const cardTail = requestedPath.startsWith(cardBase + '/') ? requestedPath.slice(cardBase.length) : null;
      let path = cardTail === '/login' ? '/api/login' : cardTail === '/logout' ? '/api/logout'
        : cardTail === '/state' ? '/api/workbench' : cardTail ? '/api/workbench' + cardTail : requestedPath;
      const method = req.method;
      if (path === '/healthz' && method === 'GET') return json(res, 200, { status: 'ok' });
      if (path === '/console' && method === 'GET') {
        res.writeHead(303, { Location: '/workbench.html' }); return res.end();
      }
      if (await webChat(req, res, path)) return;
      if (path === '/webhooks/evolution' && method === 'POST') {
        if (!webhookSecret || !engine.evolution.instance || !equal(req.headers.authorization, `Bearer ${webhookSecret}`)) throw new ServiceError('未獲授權。', 401);
        const payload = await body(req);
        let event;
        try { event = normalizeEvent(payload, engine.evolution.instance); }
        catch { throw new ServiceError('訊息事件無效。'); }
        if (event.kind === 'ignore') return json(res, 200, { ignored: event.reason });
        if (event.kind === 'receipt') {
          const results = event.receipts.map(receipt => engine.recordReceipt(receipt));
          return json(res, 200, { received: true, receiptCount: results.length });
        }
        if (event.kind === 'outgoing') { engine.outgoingEcho(event); return json(res, 200, { received: true }); }
        const result = engine.receive({ channel: 'evolution', ...event, review: event.review || event.timestamp < activationAt });
        return json(res, 200, { received: true, duplicate: result.duplicate });
      }
      if (path === '/api/login' && method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new ServiceError('來源不符。', 403);
        const ip = req.socket.remoteAddress || '';
        const now = Date.now();
        for (const [key, value] of failures) if (value.until < now) failures.delete(key);
        if ((failures.get(ip)?.count || 0) >= 10) throw new ServiceError('登入嘗試太多，請十五分鐘後再試。', 429);
        const input = await body(req);
        if (!equal(input.token, adminToken)) {
          const old = failures.get(ip); failures.set(ip, { count: (old?.count || 0) + 1, until: now + 900000 });
          throw new ServiceError('管理員密碼不正確。', 401);
        }
        failures.delete(ip);
        for (const [id, expiry] of sessions) if (expiry < now) sessions.delete(id);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const id = randomBytes(32).toString('hex'); sessions.set(id, now + 12 * 3600000);
        res.setHeader('Set-Cookie', cookie(id, 12 * 3600)); return json(res, 200, { ok: true });
      }
      if (path.startsWith('/api/')) {
        const session = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(sessionCookieName+'='))?.slice(sessionCookieName.length+1);
        if (!session || (sessions.get(session) || 0) < Date.now()) throw new ServiceError('請先登入。', 401);
        if (!['GET','HEAD'].includes(method)) {
          const origin = req.headers.origin;
          if (!origin || new URL(origin).host !== req.headers.host) throw new ServiceError('來源不符，請重新開啟此頁。', 403);
        }
        if (path === '/api/logout' && method === 'POST') {
          sessions.delete(session); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true });
        }
        if (workbench && path === '/api/workbench/inbox/events' && method === 'GET') {
          if(eventStreams.size>=20)throw new ServiceError('已開啟太多即時對話窗口。',429);
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          let closed=false,unsubscribe=()=>{},heartbeat;
          const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe();eventStreams.delete(close);res.end();};
          const hint=()=>{if(closed)return;if((sessions.get(session)||0)<Date.now()){close();return;}res.write('event: change\ndata: {"changed":true}\n\n');};
          unsubscribe=store.subscribe(hint);eventStreams.add(close);
          heartbeat=setInterval(()=>{if((sessions.get(session)||0)<Date.now())close();else if(!closed)res.write(': keepalive\n\n');},15000);heartbeat.unref();
          req.on('close',close);res.on('close',close);hint();return;
        }
        if (workbench && path === '/api/workbench/inbox' && method === 'GET') {
          const status=engine.inboxStatus();
          const conversations=store.conversations().filter(c=>['evolution','web'].includes(c.channel));
          const actualIds=new Set(conversations.map(c=>c.id));
          const pendingHandoffs=status.pending.filter(t=>actualIds.has(t.conversationId));
          return json(res,200,{...status,conversations,pendingHandoffs,pendingCount:pendingHandoffs.length,revision:store.value('revision')});
        }
        if (workbench && path === '/api/workbench/inbox/config') {
          if(method==='GET')return json(res,200,engine.inboxStatus());
          if(method==='PUT')return json(res,200,engine.configureInbox(await body(req)));
        }
        if (workbench && path === '/api/workbench/inbox/faq') {
          if(method==='GET')return json(res,200,{rules:engine.listFaq()});
          if(method==='POST')return json(res,201,engine.addFaq(await body(req)));
        }
        if (inboxContext && path === '/api/workbench/inbox/context' && method === 'GET') return json(res,200,inboxContext.capture(new URL(req.url,'http://localhost').searchParams.get('conversationId')));
        if (inboxContext && path === '/api/workbench/inbox/draft' && method === 'POST') return json(res,201,inboxContext.save(await body(req)));
        if (dotTasks && path === '/api/workbench/dot/tasks') {
          if (method === 'GET') return json(res, 200, { tasks: dotTasks.list() });
          if (method === 'POST') {
            const result = dotTasks.create(await body(req));
            return json(res, result.created ? 201 : 200, { task: result.task });
          }
        }
        const dotTask = dotTasks && path.match(/^\/api\/workbench\/dot\/tasks\/([\w-]+)$/);
        if (dotTask) {
          if (method === 'GET') return json(res, 200, { task: dotTasks.get(dotTask[1]) });
          if (method === 'PUT') return json(res, 200, { task: dotTasks.update(dotTask[1], await body(req)) });
        }
        if (workbench && path === '/api/workbench' && method === 'GET') return json(res,200,{
          profile:store.value('profile'),settings:store.value('settings'),knowledge:store.all('SELECT * FROM knowledge ORDER BY created_at DESC'),
          training:store.all('SELECT role,content FROM (SELECT * FROM training_turns ORDER BY id DESC LIMIT 40) ORDER BY id'),connections:{...workbench.status(),webChat:{enabled:webChatEnabled,path:'/chat'}},
        });
        if (workbench && path === '/api/workbench/profile' && method === 'PUT') {
          const input=await body(req),p=input.profile||{},s=input.settings||{};
          const profile={name:string(p.name,80,false),industry:string(p.industry,80,false),service:string(p.service,500,false),instructions:string(p.instructions,2000,false),tone:choice(p.tone,['friendly','formal'])};
          const settings={mode:choice(s.mode,['review','auto']),handoffContact:string(s.handoffContact,300,false)};
          store.transaction(()=>{store.set('profile',profile);store.set('settings',settings);store.revise();store.audit('workbench_profile');});return json(res,200,{ok:true});
        }
        if (workbench && path === '/api/workbench/training' && method === 'POST') {
          const text=string((await body(req)).text,2000);
          if(store.get('SELECT count(*) AS n FROM knowledge').n>=100)throw new ServiceError('已達 100 條記憶，請先整理舊記憶。');
          const history=store.all('SELECT role,content FROM (SELECT * FROM training_turns ORDER BY id DESC LIMIT 12) ORDER BY id');
          let learned;try{learned=engine.inboxPolicy().enabled?{remember:true,title:text.slice(0,28),category:'general',content:text,text:'已保存原文為待確認記憶；直接回覆請另外建立已確認問題與答案。'}:await engine.agent.learn(text,history);}catch{throw new ServiceError('訓練未完成，沒有新增記憶。請檢查 AI 接駁後再試。',502);}
          const id=randomUUID();
          store.transaction(()=>{
            if(learned.remember){
              if(store.get('SELECT count(*) AS n FROM knowledge').n>=100)throw new ServiceError('已達 100 條記憶，請先整理。');
              store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)',id,learned.title,learned.category,learned.content,0,null,Date.now());store.revise();
            }
            store.run('INSERT INTO training_turns(role,content,created_at) VALUES (?,?,?)','user',text,Date.now());
            store.run('INSERT INTO training_turns(role,content,created_at) VALUES (?,?,?)','assistant',learned.text,Date.now());
            store.audit('training_proposed',learned.remember?id:'');
          });return json(res,201,{ok:true});
        }
        if (workbench && path === '/api/workbench/trial' && method === 'POST') {
          if(engine.inboxPolicy().enabled)throw new ServiceError('目前使用知識庫直接回覆模式，不會呼叫模型。請在即時對話處理來訊，或新增已確認的問題與答案。',409);
          const input=await body(req),text=string(input.text,2000);
          if(!Array.isArray(input.history)||input.history.length>100)throw new ServiceError('試聊背景無效。');
          const history=input.history.slice(-24).map(x=>({role:choice(x.role,['user','assistant']),content:string(x.content,2000)}));
          const revision=store.value('revision'),facts=store.facts();let result;
          try{result=await engine.agent.reply({profile:store.value('profile'),facts,history:[...history,{role:'user',content:text}]});}
          catch{throw new ServiceError('AI 未能完成回覆，請檢查接駁及額度後再試。',502);}
          if(revision!==store.value('revision')||result.sourceIds.some(id=>!store.facts().some(f=>f.id===id)))throw new ServiceError('記憶或設定已更新，請再試一次。',409);
          return json(res,200,{...result,sources:facts.filter(f=>result.sourceIds.includes(f.id)).map(f=>({id:f.id,title:f.title}))});
        }
        if(workbench && path.startsWith('/api/workbench/connections/')){
          const action=path.split('/').at(-1);
          if(method==='POST'&&action==='model')return json(res,200,await workbench.model(await body(req)));
          if(method==='DELETE'&&action==='model'){await workbench.clearAI();return json(res,200,{ok:true});}
          if(method==='POST'&&action==='whatsapp')return json(res,200,await workbench.whatsapp(await body(req)));
          if(method==='POST'&&action==='whatsapp-check')return json(res,200,await workbench.checkWhatsApp());
          if(method==='POST'&&action==='whatsapp-webhook')return json(res,200,await workbench.registerWebhook());
          if(method==='POST'&&action==='whatsapp-webhook-check')return json(res,200,await workbench.checkWebhook());
          if(method==='POST'&&action==='whatsapp-test-recipients')return json(res,200,await workbench.configureTestRecipient(await body(req)));
          if(method==='GET'&&action==='whatsapp-inbox')return json(res,200,await workbench.getInboxScope());
          if(method==='POST'&&action==='whatsapp-inbox')return json(res,200,await workbench.configureInboxScope(await body(req)));
          if(method==='DELETE'&&action==='whatsapp'){await workbench.clearWhatsApp();return json(res,200,{ok:true});}
        }
        if (workbench && path === '/api/workbench/conversations' && method === 'GET') return json(res,200,{conversations:store.conversations()});
        if (workbench && /^\/api\/workbench\/(knowledge|conversations|messages)\//.test(path)) path = path.replace('/api/workbench/', '/api/');
        if (path === '/api/state' && method === 'GET') return json(res, 200, {
          profile: store.value('profile'), settings: store.value('settings'), knowledge: store.all('SELECT * FROM knowledge ORDER BY created_at DESC'),
          conversations: store.conversations(), runtime: runtime(), identity,
        });
        if (path === '/api/profile' && method === 'PUT') {
          const input = await body(req);
          const profile = { name: string(input.name,80,false), industry:string(input.industry??store.value('profile').industry??'',80,false), service: string(input.service,500,false), instructions: string(input.instructions,2000,false), tone: choice(input.tone,['friendly','formal']) };
          store.transaction(() => { store.set('profile', profile); store.revise(); store.audit('update_profile'); });
          return json(res, 200, { profile });
        }
        if (path === '/api/settings' && method === 'PUT') {
          const input = await body(req);
          const settings = { mode: choice(input.mode,['review','auto']), handoffContact: string(input.handoffContact,300,false) };
          store.transaction(() => { store.set('settings', settings); store.revise(); store.audit('update_settings'); });
          return json(res, 200, { settings });
        }
        if (path === '/api/knowledge' && method === 'POST') {
          const input = await body(req);
          const title = string(input.title,100), content = string(input.content,2000), category = choice(input.category,['price','hours','refund','general']);
          const expires = input.expiresAt ? Date.parse(string(input.expiresAt,40)) : null;
          if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) throw new ServiceError('有效期必須是未來日期。');
          if (store.get('SELECT count(*) AS n FROM knowledge').n >= 100) throw new ServiceError('第一版最多保存 100 條資料，請先整理舊資料。');
          const id = randomUUID();
          store.transaction(() => {
            store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', id, title, category, content, input.approved === true ? 1 : 0, expires, Date.now());
            store.revise(); store.audit(input.approved === true ? 'knowledge_approved' : 'knowledge_proposed', id);
          });
          return json(res, 201, { id });
        }
        const knowledge = path.match(/^\/api\/knowledge\/([\w-]+)$/);
        if (knowledge && ['POST','PUT','DELETE'].includes(method)) {
          const id = knowledge[1]; const item = store.get('SELECT * FROM knowledge WHERE id=?', id);
          if (!item) throw new ServiceError('找不到資料。', 404);
          if (method === 'POST' && item.expires_at && item.expires_at <= Date.now()) throw new ServiceError('資料已過期，請新增已更新的版本。');
          const edit=method==='PUT'?await body(req):null;
          const updated=edit?string(edit.content,2000):null;
          const category=edit?choice(edit.category??item.category,['general','hours','price','refund','style']):null;
          store.transaction(() => {
            if(method==='PUT')store.run('UPDATE knowledge SET content=?,category=?,approved=0 WHERE id=?',updated,category,id);
            else
            store.run(method === 'DELETE' ? 'DELETE FROM knowledge WHERE id=?' : 'UPDATE knowledge SET approved=1 WHERE id=?', id);
            store.revise(); store.audit(method === 'DELETE' ? 'knowledge_deleted' : method==='PUT'?'knowledge_edited':'knowledge_approved', id);
          });
          return json(res, 200, { ok: true });
        }
        if (path === '/api/demo' && method === 'POST') {
          const input = await body(req); let address = randomUUID();
          if (input.conversationId) {
            const c = engine.requireConversation(string(input.conversationId,100));
            if (c.channel !== 'demo') throw new ServiceError('試聊不能寫入真實客戶對話。');
            address = c.address;
          }
          return json(res, 201, engine.receive({ address, text: string(input.text) }));
        }
        const conv = path.match(/^\/api\/conversations\/([\w-]+)(?:\/(takeover|resume|reply))?$/);
        if (conv) {
          const id = conv[1]; engine.requireConversation(id);
          if (method === 'GET' && !conv[2]) return json(res, 200, { conversation: store.conversation(id), messages: store.messages(id), revision:store.value('revision') });
          if (method === 'DELETE' && !conv[2]) {
            if (store.get("SELECT id FROM messages WHERE conversation_id=? AND status='sending'", id)) throw new ServiceError('仍有訊息正在發送，請稍後再刪除。',409);
            if (engine.running) throw new ServiceError('正在處理訊息，請稍後再刪除。',409);
            store.run('DELETE FROM conversations WHERE id=?', id); store.audit('conversation_deleted', id);
            return json(res,200,{ok:true});
          }
          if (method === 'POST' && ['takeover','resume'].includes(conv[2])) {
            engine.takeover(id, conv[2] === 'resume' ? 'ai' : 'human'); return json(res, 200, { ok: true });
          }
          if (method === 'POST' && conv[2] === 'reply') return json(res, 201, { id: engine.manualReply(id, string((await body(req)).text)) });
        }
        const approval = path.match(/^\/api\/messages\/([\w-]+)\/approve$/);
        if (approval && method === 'POST') { const input = await body(req); engine.approve(approval[1], string(input.text,4000,false)); return json(res,200,{ok:true}); }
        throw new ServiceError('找不到此操作。', 404);
      }
      const assets = { '/': ['workbench.html','text/html; charset=utf-8'], '/diagnostics/console': ['index.html','text/html; charset=utf-8'], '/workbench.html':['workbench.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/style.css': ['style.css','text/css; charset=utf-8'],
        '/chat':['chat.html','text/html; charset=utf-8'], '/chat.js':['chat.js','text/javascript; charset=utf-8'], '/chat.css':['chat.css','text/css; charset=utf-8'],
        '/workbench.js':['workbench.js','text/javascript; charset=utf-8'], '/workbench-api.js':['workbench-api.js','text/javascript; charset=utf-8'], '/workbench.css':['workbench.css','text/css; charset=utf-8'],
        '/agent-handoff.js':['agent-handoff.js','text/javascript; charset=utf-8'],
        '/inbox-tools.js':['inbox-tools.js','text/javascript; charset=utf-8'],
        '/vendor/blueprint-style.css': ['vendor/blueprint-style.css','text/css; charset=utf-8'],
        '/vendor/blueprint-studio.css': ['vendor/blueprint-studio.css','text/css; charset=utf-8'], '/brand.svg': ['brand.svg','image/svg+xml'] };
      if (method === 'GET' && assets[path]) {
        const [file, mime] = assets[path]; const content = await readFile(publicDir + file);
        res.writeHead(200, { 'Content-Type': mime }); return res.end(content);
      }
      throw new ServiceError('找不到此頁。', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof ServiceError ? error.status : 500, { error: error instanceof ServiceError ? error.message : '服務暫時未能完成，請稍後再試。' });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const closeServer=server.close.bind(server);
  server.close=(...args)=>{for(const close of [...eventStreams])close();return closeServer(...args);};
  return server;
}
