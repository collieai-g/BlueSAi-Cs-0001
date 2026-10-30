import { createHash, randomUUID } from 'node:crypto';
import { validateReply } from './agent.js';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Full-question matching deliberately does not invent semantic similarity or
// remove interior punctuation (for example, decimal points and product codes).
export const normalizeFaqQuestion = text => typeof text === 'string'
  ? text.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(/[?？!！。]+$/gu, '').trim().toLowerCase() : '';

export class Engine {
  constructor(store, agent, evolution, { now = Date.now, responseTimeoutMs = 30000, deadlinePollMs = 250, localInbox = false } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > 86400000 ||
        !Number.isSafeInteger(deadlinePollMs) || deadlinePollMs < 1 || deadlinePollMs > 60000) throw new Error('INVALID_DEADLINE_OPTIONS');
    this.store = store; this.agent = agent; this.evolution = evolution;
    this.now = now; this.responseTimeoutMs = responseTimeoutMs; this.deadlinePollMs = deadlinePollMs;
    this.running = false; this.dispatching = false; this.stopping = false; this.webChatEnabled = false;
    this.generation = null;
    this.updatePaused = false;
    this.runtimeVersion = null;
    // The local worker follows the saved reply policy for new arrivals only.
    // Process-local work IDs prevent reconnects from replaying old jobs or sends.
    this.localInboxScope=localInbox?{receive:false,manual:false,jobs:new Set(),sends:new Set()}:null;
    this.selfReply = { available:false,enabled:false,automaticFaq:false,grantId:null,requiresNewMessage:true };
    this.selfReplySender = null;
    this.watchStore();
    store.recover();
    for (const m of store.all("SELECT id FROM messages WHERE provider_id IS NOT NULL AND provider_instance IS NOT NULL AND role IN ('assistant','staff')")) this.reconcileReceipts(m.id);
    this.checkDeadlines();
  }
  requireConversation(id) {
    const c = this.store.conversation(id);
    if (!c) throw new ServiceError('找不到對話。', 404);
    return c;
  }
  pauseForUpdate() { this.updatePaused = true; }
  resumeAfterUpdate() { this.updatePaused = false; }
  updateBusy() { return Boolean(this.running || this.dispatching || this.generation); }
  setRuntimeVersion(context) {
    this.runtimeVersion = {...context};
    // This versioned audit extension is additive to service schema 7. Earlier
    // services ignore it; it does not alter messages, jobs or business grants.
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS managed_job_versions (
      job_id TEXT PRIMARY KEY, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      result_message_id TEXT, created_at INTEGER NOT NULL)`);
  }
  bindRuntimeJob(jobId) {
    if(!this.runtimeVersion)return true;
    const old=this.store.get('SELECT snapshot_json FROM managed_job_versions WHERE job_id=?',jobId);
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const snapshot={runtime:this.runtimeVersion,prompt:{source_release_id:this.runtimeVersion.release_id,kind:'runtime_bundled'},knowledge_revision:this.store.value('revision'),
      knowledge:this.store.facts().map(f=>({id:f.id,sha256:digest([f.category,f.content,f.approved,f.expires_at])})).sort((a,b)=>a.id.localeCompare(b.id)),
      policy_sha256:digest(this.inboxPolicy()),model:{provider:this.agent.provider||'none',model:this.agent.model||null}};
    // A recovered or invalidated attempt cannot silently use a new known model,
    // rule set or knowledge snapshot even when its executable release is equal.
    if(old)return old.snapshot_json===JSON.stringify(snapshot);
    this.store.run('INSERT INTO managed_job_versions VALUES (?,?,?,?,?)',jobId,1,JSON.stringify(snapshot),null,Date.now());
    return true;
  }
  setLocalInboxScope({receive=false,manual=false}={}) {
    if(!this.localInboxScope)throw new ServiceError('此服務沒有受限本機收件能力。',409);
    this.cancelGeneration('local_inbox_scope_changed');
    this.localInboxScope={receive:receive===true,manual:receive===true&&manual===true,jobs:new Set(),sends:new Set()};
  }
  setSelfTestReplyScope(scope,send) {
    if(!scope||typeof scope.enabled!=='boolean'||typeof scope.automaticFaq!=='boolean'||
      (scope.enabled&&(typeof scope.grantId!=='string'||!/^[\w-]{16,100}$/.test(scope.grantId)||typeof send!=='function')))throw new ServiceError('本人對話測試授權未能核對。',502);
    const next={available:scope.available===true,enabled:scope.enabled,automaticFaq:scope.enabled&&scope.automaticFaq,
      grantId:scope.enabled?scope.grantId:null,requiresNewMessage:true};
    const changed=JSON.stringify(next)!==JSON.stringify(this.selfReply);
    try{
      if(changed)this.store.transaction(()=>{
        for(const c of this.store.all("SELECT id FROM conversations WHERE channel='whatsapp_self_test'")){
          this.invalidate(c.id);this.store.run("UPDATE conversations SET state='self_test',name='WhatsApp 本人對話測試' WHERE id=?",c.id);
        }
        this.store.audit('self_test_reply_scope_changed',scope.enabled?'enabled':'disabled');
      });
    }catch(error){
      if(!next.enabled){this.selfReply=next;this.selfReplySender=null;}
      throw error;
    }
    this.selfReply=next;this.selfReplySender=scope.enabled?send:null;
    return {...this.selfReply};
  }
  selfTestReplyStatus(c) {
    const scope=this.selfReply;
    if(!c||c.channel!=='whatsapp_self_test')return {...scope,eligible:false};
    const input=this.store.get(`SELECT m.id,m.provider_id,s.grant_id FROM messages m LEFT JOIN self_test_reply_links s ON s.message_id=m.id
      WHERE m.conversation_id=? AND m.role='user' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`,c.id);
    const eligible=Boolean(scope.enabled&&input?.provider_id&&input.grant_id===scope.grantId&&
      this.now()>=c.last_customer_at&&this.now()-c.last_customer_at<86400000);
    return {...scope,eligible};
  }
  answerSelfTest(c,inputId) {
    const scope=this.selfTestReplyStatus(c),policy=this.inboxPolicy();
    if(!scope.eligible||c.state!=='self_auto'||!scope.automaticFaq||!policy.enabled||!policy.automaticKnowledge)return;
    const input=this.store.get('SELECT * FROM messages WHERE id=?',inputId);
    if(!input||/退款|退貨|refund|例外|exception|真人|人工|投訴/iu.test(input.content))return;
    const matches=this.store.all(`SELECT k.* FROM faq_rules r JOIN knowledge k ON k.id=r.knowledge_id
      WHERE r.normalized_question=? AND k.approved=1 AND (k.expires_at IS NULL OR k.expires_at>?)`,normalizeFaqQuestion(input.content),this.now());
    if(matches.length!==1||['refund','style','procedure'].includes(matches[0].category)||
      this.store.get("SELECT message_id FROM self_test_reply_links WHERE input_message_id=? AND grant_id=? AND kind='faq'",input.id,scope.grantId))return;
    const messageId=this.store.addMessage(c.id,'assistant',matches[0].content,{status:'queued',sources:[matches[0].id],decision:'answer',engine:'self-test-knowledge'});
    this.store.run('INSERT INTO self_test_reply_links VALUES (?,?,?,?,?,?)',messageId,input.id,scope.grantId,input.provider_id,'faq','self-faq-'+input.id);
    this.store.audit('self_test_faq_queued',messageId);
  }
  manualSelfTestReply(id,input) {
    const c=this.requireConversation(id),text=typeof input?.text==='string'?input.text.trim():'';
    if(c.channel!=='whatsapp_self_test'||!text||text.length>1500||typeof input.operationId!=='string'||!/^[\w-]{8,100}$/.test(input.operationId)||!Number.isSafeInteger(input.expectedVersion))throw new ServiceError('請核對本人測試對話、版本及回覆內容。');
    const previous=this.store.get(`SELECT m.id,m.conversation_id,m.content,m.status FROM self_test_reply_links s JOIN messages m ON m.id=s.message_id WHERE s.operation_id=?`,input.operationId);
    if(previous){if(previous.conversation_id!==id||previous.content!==text)throw new ServiceError('同一測試操作不能改為另一段回覆。',409);return {messageId:previous.id,operationId:input.operationId,status:previous.status,selfTest:true,sent:['accepted','delivered','read'].includes(previous.status)};}
    const scope=this.selfTestReplyStatus(c);
    if(!scope.eligible)throw new ServiceError('請先開啟本人對話回覆測試，再從手機傳一則新文字。',409);
    if(c.version!==input.expectedVersion)throw new ServiceError('本人對話已更新，請先讀取最新訊息再發送。',409);
    const last=this.store.get("SELECT * FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",id);
    if(this.store.get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='staff' AND created_at>?",id,Date.now()-60000).n>=5)throw new ServiceError('本人測試回覆太頻密，請稍後再試。',429);
    return this.store.transaction(()=>{
      this.invalidate(id);this.store.run("UPDATE conversations SET state='self_human' WHERE id=?",id);
      const messageId=this.store.addMessage(id,'staff',text,{status:'queued',engine:'self-test-manual',decision:'test_reply'});
      this.store.run('INSERT INTO self_test_reply_links VALUES (?,?,?,?,?,?)',messageId,last.id,scope.grantId,last.provider_id,'manual',input.operationId);
      this.store.audit('self_test_manual_queued',messageId);
      return {messageId,operationId:input.operationId,status:'queued',selfTest:true,sent:false};
    });
  }
  async dispatchSelfTest(m,c) {
    const link=this.store.get('SELECT * FROM self_test_reply_links WHERE message_id=?',m.id),scope=this.selfTestReplyStatus(c);
    const facts=new Map(this.store.facts(this.now()).map(f=>[f.id,f]));
    const sources=JSON.parse(m.sources),policy=this.inboxPolicy();
    const sourceOkay=m.role==='staff'||(sources.length>0&&sources.every(id=>facts.has(id)&&!['refund','style','procedure'].includes(facts.get(id).category)));
    const stateOkay=m.role==='staff'?c.state==='self_human':c.state==='self_auto'&&scope.automaticFaq&&policy.enabled&&policy.automaticKnowledge;
    if(!scope.eligible||!link||link.grant_id!==scope.grantId||!stateOkay||!sourceOkay||m.version!==c.version||m.config_version!==this.store.value('revision')||!this.selfReplySender){
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?",m.id);return;
    }
    this.store.run("UPDATE messages SET status='sending' WHERE id=? AND status='queued'",m.id);
    try{
      const result=await this.selfReplySender({text:m.content,grantId:scope.grantId,replyToId:link.request_provider_id,operationId:link.operation_id,linkPreview:false});
      if(typeof result?.providerId!=='string'||!result.providerId)throw new Error('SELF_REPLY_RESULT_UNKNOWN');
      this.store.run("UPDATE messages SET status='accepted',provider_id=?,provider_instance=? WHERE id=?",result.providerId,this.evolution.instance,m.id);
      this.reconcileReceipts(m.id);this.store.audit('self_test_reply_accepted',m.id);
    }catch{
      this.store.run("UPDATE messages SET status='uncertain' WHERE id=?",m.id);this.store.audit('self_test_reply_uncertain',m.id);
      if(this.selfReply.grantId===scope.grantId)this.setSelfTestReplyScope({available:scope.available,enabled:false,automaticFaq:false});
    }
  }
  get agent() { return this._agent; }
  set agent(next) {
    if (this._agent && this._agent !== next) this.cancelGeneration('provider_changed');
    this._agent = next;
  }
  watchStore() {
    if (this.unsubscribeStore) return;
    this.unsubscribeStore = this.store.subscribe(() => {
      const active = this.generation;
      if (!active) return;
      if (active.agent !== this.agent) this.cancelGeneration('provider_changed');
      else if (active.revision !== this.store.value('revision')) this.cancelGeneration('revision_changed');
    });
  }
  cancelGeneration(reason, conversationId) {
    const active = this.generation;
    if (active && (!conversationId || active.conversationId === conversationId) && !active.controller.signal.aborted) active.controller.abort(reason);
  }
  // A provider or policy change applies to future input, never resubmits an old
  // customer request under newly granted automation permissions.
  retirePending(reason) {
    const unanswered = this.store.all(`SELECT DISTINCT c.id FROM conversations c WHERE c.state='ai'
      AND (EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM response_windows w WHERE w.conversation_id=c.id AND w.status='pending'))`);
    for (const row of unanswered) {
      if (!this.pendingWindow(row.id)) {
        const message = this.store.get("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1", row.id);
        if (message) this.openWindow(row.id, message.id, this.now());
      }
      const window = this.pendingWindow(row.id);
      if (window) this.handoffWindow(window, reason);
    }
    this.store.run("UPDATE jobs SET state='done' WHERE state IN ('pending','running')");
  }
  replaceAgent(candidate, selection = {provider:candidate.configured ? (candidate.provider||'openai') : 'none',model:candidate.model||''}) {
    const previous = this.agent;
    this.cancelGeneration('provider_changed');
    this.store.transaction(() => {
      this.store.revise();
      this.retirePending('provider_changed');
      this.store.set('reply_provider',selection);
      this.store.audit('reply_provider_changed');
    });
    this.agent = candidate;
    return previous;
  }
  inboxPolicy() {
    const policy = this.store.value('inbox_policy');
    return { enabled: policy.enabled === true, automaticKnowledge: policy.automaticKnowledge === true,
      aiFallback: policy.aiFallback === true, automaticAi: policy.automaticAi === true };
  }
  inboxStatus() {
    const pending = this.store.all(`SELECT h.id,h.conversation_id,h.reason,h.created_at FROM handoff_tasks h
      JOIN conversations c ON c.id=h.conversation_id
      WHERE h.status='pending' AND c.state IN ('waiting','human')
      AND h.rowid=(SELECT MAX(h2.rowid) FROM handoff_tasks h2 WHERE h2.conversation_id=h.conversation_id AND h2.status='pending')
      ORDER BY h.created_at DESC LIMIT 200`).map(row=>({id:row.id,conversationId:row.conversation_id,reason:row.reason,createdAt:row.created_at}));
    const pendingCount = this.store.get(`SELECT COUNT(DISTINCT h.conversation_id) AS n FROM handoff_tasks h
      JOIN conversations c ON c.id=h.conversation_id WHERE h.status='pending' AND c.state IN ('waiting','human')`).n;
    return { policy: this.inboxPolicy(), selfTestReply:{...this.selfReply}, pendingCount, pending, hasMore: pendingCount > pending.length,
      notification: { scope: 'local_card', externalNotified: false } };
  }
  configureInbox(input) {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.automaticKnowledge !== 'boolean' ||
      ['aiFallback','automaticAi'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')) throw new ServiceError('請確認收件箱、知識庫及 AI 自動回覆設定。');
    return this.store.transaction(()=>{
      const previous = this.inboxPolicy();
      const next = { enabled: input.enabled, automaticKnowledge: input.automaticKnowledge,
        aiFallback: input.aiFallback ?? previous.aiFallback, automaticAi: input.automaticAi ?? previous.automaticAi };
      if ((next.aiFallback && !next.enabled) || (next.automaticAi && !next.aiFallback)) throw new ServiceError('請先啟用知識庫優先及 AI 後備，再選擇 AI 自動發送。');
      if ((next.aiFallback || next.automaticAi) && !this.agent.configured) throw new ServiceError('請先接駁並核對可用的 AI，再啟用 AI 後備。',409);
      if (JSON.stringify(previous) === JSON.stringify(next)) return this.inboxStatus();
      this.cancelGeneration('policy_changed');
      this.store.set('inbox_policy', next); this.store.revise();
      this.retirePending('reply_policy_changed');
      this.store.audit('inbox_policy_changed');
      return this.inboxStatus();
    });
  }
  addFaq(input) {
    const question = typeof input?.question === 'string' ? input.question.trim() : '';
    const answer = typeof input?.answer === 'string' ? input.answer.trim() : '';
    const normalized = normalizeFaqQuestion(question);
    if (!question || question.length > 500 || !normalized || !answer || answer.length > 2000 || typeof input.approved !== 'boolean') throw new ServiceError('請填寫完整問題、答案及是否確認採用。');
    return this.store.transaction(()=>{
      if (this.store.get('SELECT count(*) AS n FROM knowledge').n >= 100 || this.store.get('SELECT count(*) AS n FROM faq_rules').n >= 100) throw new ServiceError('已達 100 條資料，請先整理舊記憶。');
      const id = randomUUID(), knowledgeId = randomUUID(), now = Date.now();
      const category = /退款|退貨|refund/iu.test(question) ? 'refund' : 'general';
      this.store.run('INSERT INTO knowledge VALUES (?,?,?,?,?,?,?)', knowledgeId, question.slice(0,100), category, answer, input.approved ? 1 : 0, null, now);
      this.store.run('INSERT INTO faq_rules VALUES (?,?,?,?,?)', id, knowledgeId, question, normalized, now);
      if(input.approved)this.store.revise(); this.store.audit(input.approved ? 'faq_approved' : 'faq_proposed', id);
      return { id, knowledgeId, question, answer, approved: input.approved };
    });
  }
  listFaq() {
    return this.store.all(`SELECT r.id,r.knowledge_id,r.question,k.content,k.approved,k.expires_at FROM faq_rules r
      JOIN knowledge k ON k.id=r.knowledge_id ORDER BY r.created_at DESC,r.rowid DESC`).map(row=>({
      id:row.id,knowledgeId:row.knowledge_id,question:row.question,answer:row.content,approved:Boolean(row.approved),expiresAt:row.expires_at,
      usable:Boolean(row.approved && (row.expires_at == null || row.expires_at > Date.now())) }));
  }
  answerFromKnowledge(c, message, forcedReason = '', { scheduleAi = true } = {}) {
    if (!c || c.channel === 'whatsapp_self_test' || c.state !== 'ai') return;
    if (this.store.get("SELECT id FROM messages WHERE conversation_id=? AND version=? AND engine='knowledge' AND status<>'cancelled'", c.id, c.version)) return;
    const matches = this.store.all(`SELECT k.* FROM faq_rules r JOIN knowledge k ON k.id=r.knowledge_id
      WHERE r.normalized_question=? AND k.approved=1 AND (k.expires_at IS NULL OR k.expires_at>?)`, normalizeFaqQuestion(message.content), this.now());
    let reason = forcedReason;
    if (!reason && (/退款|退貨|refund|例外|exception/iu.test(message.content) || matches.some(row=>row.category==='refund'))) reason = 'knowledge_requires_human';
    if (!reason && matches.length !== 1) reason = matches.length ? 'knowledge_conflict' : 'knowledge_missing';
    if (!reason && matches.some(row=>['style','procedure'].includes(row.category))) reason = 'knowledge_missing';
    if (reason === 'knowledge_missing' && this.inboxPolicy().aiFallback && this.agent.configured) {
      this.openWindow(c.id, message.id, this.now());
      if (scheduleAi) this.store.run('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?)', message.id, c.id, c.version, 'pending', Date.now());
      return 'ai';
    }
    if (reason) {
      this.openWindow(c.id, message.id, this.now());
      const window = this.pendingWindow(c.id);
      if (window) this.handoffWindow(window, reason);
      return;
    }
    const automatic = this.currentLocalInput(c,message.id) && this.inboxPolicy().automaticKnowledge &&
      (c.channel === 'demo' || (c.channel === 'web' ? this.webChatEnabled : this.liveReady()));
    const replyId=this.store.addMessage(c.id, 'assistant', matches[0].content, {
      status: automatic ? 'queued' : 'draft', sources: [matches[0].id], decision: 'answer', engine: 'knowledge',
    });
    if(automatic&&c.channel==='evolution'&&this.localInboxScope)this.localInboxScope.sends.add(replyId);
    this.store.audit(automatic ? 'knowledge_reply_queued' : 'knowledge_reply_drafted', c.id);
  }
  invalidate(id) {
    this.cancelGeneration('conversation_changed', id);
    this.store.run('UPDATE conversations SET version=version+1, updated_at=? WHERE id=?', Date.now(), id);
    this.store.run("UPDATE messages SET status='cancelled' WHERE conversation_id=? AND status IN ('draft','queued')", id);
  }
  pendingWindow(id) {
    return this.store.get("SELECT * FROM response_windows WHERE conversation_id=? AND status='pending'", id);
  }
  openWindow(id, messageId, now) {
    if (this.pendingWindow(id)) return;
    this.store.run('INSERT INTO response_windows(id,conversation_id,first_message_id,opened_at,deadline_at,status) VALUES (?,?,?,?,?,?)',
      randomUUID(), id, messageId, now, now + this.responseTimeoutMs, 'pending');
  }
  closeWindow(id, status, reason, now = this.now()) {
    this.store.run("UPDATE response_windows SET status=?,reason=?,resolved_at=? WHERE conversation_id=? AND status='pending'", status, reason, now, id);
  }
  // Call within the same transaction as the control-state change. One durable
  // local task per response window does not claim that an external alert was sent.
  handoffWindow(window, reason, now = this.now()) {
    const current = this.store.get("SELECT * FROM response_windows WHERE id=? AND status='pending'", window.id);
    if (!current) return false;
    const c = this.store.conversation(current.conversation_id);
    if (!c || c.state !== 'ai') {
      this.closeWindow(current.conversation_id, 'cancelled', 'control_changed', now); return false;
    }
    this.invalidate(c.id);
    this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
    this.closeWindow(c.id, 'handed_off', reason, now);
    this.store.run("UPDATE jobs SET state='done' WHERE conversation_id=? AND state IN ('pending','running')", c.id);
    this.store.run('INSERT OR IGNORE INTO handoff_tasks(id,window_id,conversation_id,reason,status,created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(), current.id, c.id, reason, 'pending', now);
    this.store.audit(reason === 'deadline' ? 'deadline_handoff' : 'handoff_requested', c.id);
    return true;
  }
  checkDeadlines() {
    const now = this.now();
    return this.store.transaction(() => {
      let expired = 0;
      for (const window of this.store.all("SELECT * FROM response_windows WHERE status='pending' AND deadline_at<=? ORDER BY deadline_at", now)) {
        if (this.handoffWindow(window, 'deadline', now)) expired++;
      }
      return expired;
    });
  }
  takeover(id, state = 'human') {
    const conversation = this.requireConversation(id);
    if(this.localInboxScope&&conversation.channel==='evolution'&&state==='ai'&&!this.localInboxScope.receive)throw new ServiceError('請先核對 WhatsApp 新私人文字收件。',409);
    if (conversation.channel === 'whatsapp_self_test') {
      if(!this.selfTestReplyStatus(conversation).eligible)throw new ServiceError('請先開啟本人對話回覆測試，並從手機傳一則新文字。',409);
      return this.store.transaction(()=>{this.invalidate(id);this.store.run('UPDATE conversations SET state=? WHERE id=?',state==='ai'?'self_auto':'self_human',id);this.store.audit('self_test_control_changed',id);});
    }
    this.store.transaction(() => {
      this.invalidate(id);
      this.closeWindow(id, 'cancelled', state === 'ai' ? 'resume' : 'manual_takeover');
      this.store.run("UPDATE jobs SET state='done' WHERE conversation_id=? AND state IN ('pending','running')", id);
      this.store.run('UPDATE conversations SET state=? WHERE id=?', state, id);
      if (state === 'ai') this.store.run("UPDATE handoff_tasks SET status='acknowledged' WHERE conversation_id=? AND status='pending'", id);
      this.store.audit(state === 'ai' ? 'resume' : 'takeover', id);
    });
  }
  receive({ channel = 'demo', address = randomUUID(), name = '試聊客人', eventId = randomUUID(), text, timestamp = Date.now(), review = false }) {
    if(this.updatePaused)throw new ServiceError('客服正在更新，請稍後重試。',503);
    if (channel === 'whatsapp_self_test') throw new ServiceError('自傳測試須使用獨立的只讀收件路線。',409);
    if(channel==='evolution'&&this.localInboxScope&&!this.localInboxScope.receive)throw new ServiceError('本機新私人文字收件尚未獲授權。',403);
    this.checkDeadlines();
    return this.store.transaction(() => {
      const receivedAt = this.now();
      const key = `${channel}:${eventId}`;
      if (this.store.get('SELECT id FROM events WHERE id=?', key)) return { duplicate: true };
      this.store.run('INSERT INTO events VALUES (?,?)', key, Date.now());
      let c = this.store.get('SELECT * FROM conversations WHERE channel=? AND address=?', channel, address);
      if (!c) {
        const id = randomUUID();
        this.store.run('INSERT INTO conversations(id,channel,address,name,updated_at) VALUES (?,?,?,?,?)', id, channel, address, name, Date.now());
        c = this.store.conversation(id);
      }
      this.invalidate(c.id);
      this.store.run('UPDATE conversations SET last_customer_at=MAX(last_customer_at,?) WHERE id=?', timestamp, c.id);
      const id = this.store.addMessage(c.id, 'user', text, { providerId: ['evolution','web'].includes(channel) ? eventId : null, providerInstance: channel === 'evolution' ? this.evolution.instance : null });
      if (channel === 'evolution' && this.evolution.instance) this.store.run(`INSERT INTO channel_activity(instance,last_incoming_at) VALUES (?,?)
        ON CONFLICT(instance) DO UPDATE SET last_incoming_at=excluded.last_incoming_at`, this.evolution.instance, receivedAt);
      if(channel==='evolution'&&this.localInboxScope)this.localInboxScope.jobs.add(id);
      if (this.inboxPolicy().enabled) {
        const current = this.store.conversation(c.id);
        const reason = review ? 'incoming_needs_review' : /真人|人工|投訴|human|complaint/iu.test(text) ? 'customer_requests_human' : '';
        this.answerFromKnowledge(current, this.store.get('SELECT * FROM messages WHERE id=?', id), reason);
        return { conversationId: c.id, messageId: id, duplicate: false };
      }
      if (this.agent.provider === 'codex-cli') {
        if (c.state === 'ai') {
          this.openWindow(c.id,id,receivedAt);
          this.handoffWindow(this.pendingWindow(c.id),'ai_fallback_disabled',receivedAt);
        }
        return {conversationId:c.id,messageId:id,duplicate:false};
      }
      if (c.state === 'ai') this.openWindow(c.id, id, receivedAt);
      if (review || /真人|人工|投訴|human|complaint/i.test(text)) {
        const window = this.pendingWindow(c.id);
        if (window) this.handoffWindow(window, review ? 'incoming_needs_review' : 'customer_requests_human', receivedAt);
        else this.store.run("UPDATE conversations SET state=CASE WHEN state='human' THEN state ELSE 'waiting' END WHERE id=?", c.id);
        this.store.audit(review ? 'incoming_needs_review' : 'customer_requests_human', c.id);
      }
      c = this.store.conversation(c.id);
      if (c.state === 'ai') this.store.run('INSERT INTO jobs VALUES (?,?,?,?,?)', id, c.id, c.version, 'pending', Date.now());
      return { conversationId: c.id, messageId: id, duplicate: false };
    });
  }
  receiveSelfTest({address,eventId,text,timestamp,replyGrantId=null}) {
    if (typeof address !== 'string' || !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(address) ||
        typeof eventId !== 'string' || !eventId || eventId.length > 300 || typeof text !== 'string' || !text.trim() || text.length > 4000 ||
        !Number.isFinite(timestamp) || timestamp < this.now()-300000 || timestamp > this.now()+60000) throw new ServiceError('自傳測試訊息無效。');
    return this.store.transaction(()=>{
      const key = `whatsapp_self_test:${this.evolution.instance || ''}:${address}:${eventId}`;
      if (this.store.get('SELECT id FROM events WHERE id=?',key)) return {duplicate:true};
      this.store.run('INSERT INTO events VALUES (?,?)',key,this.now());
      let c = this.store.get("SELECT * FROM conversations WHERE channel='whatsapp_self_test' AND address=?",address);
      if (!c) {
        const id = randomUUID();
        this.store.run('INSERT INTO conversations(id,channel,address,name,state,updated_at) VALUES (?,?,?,?,?,?)',
          id,'whatsapp_self_test',address,'WhatsApp 自傳測試（只讀）','self_test',this.now());
        c = this.store.conversation(id);
      }
      this.invalidate(c.id);
      const eligible=this.selfReply.enabled&&replyGrantId===this.selfReply.grantId;
      const nextState=eligible?(c.state==='self_human'?'self_human':'self_auto'):'self_test';
      this.store.run("UPDATE conversations SET state=?,name=?,last_customer_at=MAX(last_customer_at,?) WHERE id=?",nextState,eligible?'WhatsApp 本人對話測試':'WhatsApp 自傳測試（只讀）',eligible?Math.min(timestamp,this.now()):0,c.id);
      const messageId=this.store.addMessage(c.id,'user',text,{status:'received',providerId:eventId,
        providerInstance:this.evolution.instance || null,engine:'whatsapp-self-test',decision:'test_only'});
      if(eligible){
        this.store.run('INSERT INTO self_test_reply_links VALUES (?,?,?,?,?,?)',messageId,null,replyGrantId,eventId,'input',null);
        this.answerSelfTest(this.store.conversation(c.id),messageId);
      }
      this.store.audit('whatsapp_self_test_received',c.id);
      return {conversationId:c.id,messageId,duplicate:false,selfTest:true,customerAcceptance:false};
    });
  }
  outgoingEcho(event) {
    // Correlated AI echoes must not take over. Unknown outgoing traffic is conservative.
    if (this.store.get(`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.provider_id=? AND (m.provider_instance IS NULL OR m.provider_instance=?) AND c.channel='evolution' AND c.address=? AND m.role IN ('assistant','staff')`, event.eventId, this.evolution.instance || null, event.address)) return;
    let c = this.store.get("SELECT * FROM conversations WHERE channel='evolution' AND address=?", event.address);
    if (!c) return;
    if (this.store.get('SELECT id FROM events WHERE id=?', `outgoing:${event.eventId}`)) return;
    this.takeover(c.id);
    this.store.transaction(() => {
      this.store.run('INSERT INTO events VALUES (?,?)', `outgoing:${event.eventId}`, Date.now());
      this.store.addMessage(c.id, 'staff', event.text, { status: 'accepted', providerId: event.eventId, providerInstance: this.evolution.instance });
    });
  }
  recordReceipt(receipt) {
    const { instance, providerId, address, status } = receipt;
    if (!instance || instance !== this.evolution.instance || !['accepted','delivered','read','failed'].includes(status) ||
        typeof providerId !== 'string' || !providerId || providerId.length > 300 || !/^\d{5,20}@s\.whatsapp\.net$/.test(address)) throw new ServiceError('訊息狀態無效。');
    return this.store.transaction(() => {
      const now = this.now();
      const result = this.store.run('INSERT OR IGNORE INTO provider_receipts VALUES (?,?,?,?,?)', instance, providerId, address, status, now);
      const selfTest=receipt.selfTest===true||Boolean(this.store.get("SELECT id FROM conversations WHERE channel='whatsapp_self_test' AND address=?",address));
      if(!selfTest)this.store.run(`INSERT INTO channel_activity(instance,last_receipt_at) VALUES (?,?)
        ON CONFLICT(instance) DO UPDATE SET last_receipt_at=excluded.last_receipt_at`, instance, now);
      const message = this.store.get(`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.provider_instance=? AND m.provider_id=? AND c.channel IN ('evolution','whatsapp_self_test') AND c.address=? AND m.role IN ('assistant','staff')`, instance, providerId, address);
      if (message) this.reconcileReceipts(message.id);
      return { duplicate: result.changes === 0, matched: Boolean(message) };
    });
  }
  reconcileReceipts(messageId) {
    const m = this.store.get(`SELECT m.*,c.address,c.channel FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`, messageId);
    if (!m || !['evolution','whatsapp_self_test'].includes(m.channel) || !m.provider_id || !m.provider_instance || !['assistant','staff'].includes(m.role)) return;
    // A late SERVER_ACK or ERROR must never erase observed delivery/read evidence.
    const rank = { sending: 0, uncertain: 0, accepted: 1, failed: 2, delivered: 3, read: 4 };
    if (!(m.status in rank)) return;
    let next = m.status;
    for (const r of this.store.all('SELECT status FROM provider_receipts WHERE instance=? AND provider_id=? AND address=?', m.provider_instance, m.provider_id, m.address)) {
      if (rank[r.status] > rank[next]) next = r.status;
    }
    if (next !== m.status) this.store.run('UPDATE messages SET status=? WHERE id=?', next, m.id);
  }
  async processJob(job) {
    if(this.updatePaused)return;
    if(!this.bindRuntimeJob(job.id)){
      this.store.transaction(()=>{
        const window=this.pendingWindow(job.conversation_id);
        if(window)this.handoffWindow(window,'runtime_version_changed');
        this.store.run("UPDATE jobs SET state='done' WHERE id=?",job.id);
        this.store.audit('managed_job_requires_review',job.id);
      });
      return;
    }
    this.checkDeadlines();
    const c = this.store.conversation(job.conversation_id);
    if(c?.channel==='evolution'&&this.localInboxScope&&(!this.localInboxScope.receive||!this.localInboxScope.jobs.has(job.id)))return;
    if (!c || c.channel === 'whatsapp_self_test' || c.state !== 'ai' || c.version !== job.version) {
      this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id); return;
    }
    const policy = this.inboxPolicy();
    if (this.agent.provider==='codex-cli' && (!policy.enabled || !policy.aiFallback)) {
      this.store.transaction(()=>{
        const window=this.pendingWindow(c.id);
        if(window)this.handoffWindow(window,'ai_fallback_disabled');
        this.store.run("UPDATE jobs SET state='done' WHERE id=?",job.id);
      });
      return;
    }
    if (policy.enabled) {
      const outcome = this.store.transaction(()=>{
        const message = this.store.get('SELECT * FROM messages WHERE id=?', job.id);
        const result = message && this.answerFromKnowledge(c, message, '', {scheduleAi:false});
        if (result !== 'ai') this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id);
        return result;
      });
      if (outcome !== 'ai') return;
    }
    const revision = this.store.value('revision'), agent = this.agent;
    const facts = this.store.facts(), controller = new AbortController();
    const active = { conversationId:c.id, jobId:job.id, version:c.version, revision, agent, controller };
    this.generation = active;
    this.store.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
    const window = this.pendingWindow(c.id);
    const timeoutMs = Math.max(1, Math.min(this.responseTimeoutMs, window ? window.deadline_at-this.now() : this.responseTimeoutMs));
    let rejectAbort;
    const aborted = new Promise((resolve,reject)=>{rejectAbort=()=>reject(new Error('GENERATION_ABORTED'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    aborted.catch(()=>{});
    const timer = setTimeout(()=>controller.abort('generation_timeout'),timeoutMs);
    try {
      const raw = await Promise.race([agent.reply({ profile: this.store.value('profile'), facts, history: this.store.history(c.id) }, {signal:controller.signal}),aborted]);
      // Enforce the boundary even when no monitor tick occurred during the await.
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        if (!this.stopping && !controller.signal.aborted && agent === this.agent && current?.state === 'ai' && current.version === c.version && revision === this.store.value('revision')) {
          const {engine:resultEngine,...payload}=raw||{};
          let result=validateReply(payload,facts,resultEngine||agent.provider||'openai');
          const currentFacts = new Map(this.store.facts().filter(f=>f.category!=='style').map(f=>[f.id,f]));
          const inputFacts = new Map(facts.filter(f=>f.category!=='style').map(f=>[f.id,f]));
          const references=[...result.sourceIds,...(result.procedureIds||[])];
          if (references.some(id=>!inputFacts.has(id)||!currentFacts.has(id)||currentFacts.get(id).content!==inputFacts.get(id).content)) throw new Error('STALE_GENERATION_SOURCE');
          const refundSource=result.sourceIds.some(id=>currentFacts.get(id).category==='refund');
          if(refundSource)result={text:'這項退換安排需要由本人核對。',decision:'handoff',sourceIds:[],engine:result.engine};
          const settings = this.store.value('settings');
          const automatic = policy.enabled ? this.inboxPolicy().automaticAi : settings.mode === 'auto';
          const canAuto = this.currentLocalInput(c,job.id) && automatic && result.decision === 'answer' && result.sourceIds.length>0 &&
            (c.channel === 'demo' || (agent.configured && (c.channel === 'web' ? this.webChatEnabled : this.liveReady())));
          if (result.decision === 'handoff') {
            const window = this.pendingWindow(c.id);
            if (window) this.handoffWindow(window, refundSource ? 'knowledge_requires_human' : 'agent_requests_human');
            else this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
          }
          const replyId=this.store.addMessage(c.id, 'assistant', result.text, {
            status: result.decision === 'handoff' ? 'draft' : canAuto ? 'queued' : 'draft',
            sources: [...new Set([...result.sourceIds,...(result.procedureIds||[])])], decision: result.decision, engine: result.engine,
          });
          if(this.runtimeVersion)this.store.run('UPDATE managed_job_versions SET result_message_id=? WHERE job_id=?',replyId,job.id);
          if(canAuto&&c.channel==='evolution'&&this.localInboxScope)this.localInboxScope.sends.add(replyId);
          if (result.decision === 'handoff') this.store.audit(refundSource ? 'knowledge_requires_human' : 'agent_requests_human', c.id);
        }
        // A knowledge edit during generation should regenerate, not silently lose
        // a still-current customer request. Takeover/newer input remains final.
        const currentPolicy=this.inboxPolicy();
        const eligible=!currentPolicy.enabled || (currentPolicy.aiFallback && this.agent.configured);
        const next = !this.stopping && agent===this.agent && eligible && current?.state === 'ai' && current.version === c.version && revision !== this.store.value('revision') ? 'pending' : 'done';
        this.store.run('UPDATE jobs SET state=? WHERE id=?', next, job.id);
      });
    } catch {
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        const currentPolicy=this.inboxPolicy();
        const eligible=!currentPolicy.enabled || (currentPolicy.aiFallback && this.agent.configured);
        const stillCurrent = current?.state === 'ai' && current.version === c.version;
        const reason=controller.signal.reason;
        const retry = stillCurrent && eligible && agent===this.agent && (reason==='shutdown'||reason==='revision_changed'||revision!==this.store.value('revision'));
        this.store.run('UPDATE jobs SET state=? WHERE id=?', retry ? 'pending' : stillCurrent ? 'failed' : 'done', job.id);
        if (stillCurrent && !retry) {
          const window = this.pendingWindow(c.id);
          if (window) this.handoffWindow(window, 'generation_failed');
          else this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
          this.store.addMessage(c.id, 'system', 'AI 暫時未能完成回覆，請由人工處理。', { status: 'failed' });
        }
        if (!retry && stillCurrent) this.store.audit('generation_failed', c.id);
      });
    } finally {
      clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);
      if(this.generation===active)this.generation=null;
    }
  }
  currentLocalInput(c,messageId) {
    return !this.localInboxScope||c.channel!=='evolution'||Boolean(this.localInboxScope.receive&&this.localInboxScope.jobs.has(messageId));
  }
  channelReady() { return Boolean(this.evolution.configured && this.evolution.deliveryEnabled); }
  liveReady() {
    if(this.localInboxScope)return Boolean(this.localInboxScope.receive&&this.localInboxScope.manual&&this.channelReady());
    // A model-free inbox needs the explicitly enabled channel, not invented
    // merchant profile fields or a contact used only by the legacy AI workflow.
    if (this.inboxPolicy().enabled) return this.channelReady();
    const p = this.store.value('profile'); const settings = this.store.value('settings');
    return Boolean(this.channelReady() && p.name && p.service && settings.handoffContact);
  }
  approve(messageId, text) {
    this.checkDeadlines();
    const m = this.store.get('SELECT * FROM messages WHERE id=?', messageId);
    if (!m || m.status !== 'draft') throw new ServiceError('草稿已變更，請重新查看。', 409);
    const c = this.requireConversation(m.conversation_id);
    if (c.channel === 'whatsapp_self_test') throw new ServiceError('WhatsApp 自傳測試只供讀取，不可批准發送。',409);
    if (m.version !== c.version || m.config_version !== this.store.value('revision')) throw new ServiceError('資料已更新，這份草稿不能再發送。', 409);
    if (c.state !== 'ai') throw new ServiceError('請在人工回覆欄確認內容並發送。', 409);
    if (c.channel === 'evolution' && !this.liveReady()) throw new ServiceError('尚未完成真實發送設定。', 409);
    if(c.channel==='evolution'&&this.localInboxScope)this.localInboxScope.sends.add(m.id);
    this.store.run("UPDATE messages SET content=?, status='queued' WHERE id=?", text || m.content, m.id);
    this.store.audit('approve_draft', m.id);
  }
  manualReply(id, text) {
    const c = this.requireConversation(id);
    if (c.channel === 'whatsapp_self_test') throw new ServiceError('WhatsApp 自傳測試只供讀取，不可發送回覆。',409);
    if (c.state !== 'human') throw new ServiceError('請先接手對話。', 409);
    if (c.channel === 'evolution' && !this.liveReady()) throw new ServiceError('尚未完成真實發送設定。', 409);
    return this.store.transaction(()=>{
      const messageId = this.store.addMessage(id, 'staff', text, { status: 'queued' });
      if(c.channel==='evolution'&&this.localInboxScope)this.localInboxScope.sends.add(messageId);
      this.store.run("UPDATE handoff_tasks SET status='handled' WHERE conversation_id=? AND status='pending'", id);
      this.store.audit('manual_reply_queued', id);
      return messageId;
    });
  }
  async dispatch(m) {
    this.checkDeadlines();
    // A queued object may be stale after a deadline, takeover or another dispatch.
    m = this.store.get('SELECT * FROM messages WHERE id=?', m.id);
    if (!m || m.status !== 'queued') return;
    const c = this.store.conversation(m.conversation_id);
    if(c?.channel==='evolution'&&this.localInboxScope&&(!this.localInboxScope.receive||!this.localInboxScope.manual||!this.localInboxScope.sends.has(m.id)))return;
    if (c?.channel === 'whatsapp_self_test') {
      return this.dispatchSelfTest(m,c);
    }
    const stateOkay = m.role === 'staff' ? c?.state === 'human' : c?.state === 'ai';
    const policy=this.inboxPolicy();
    const nativeDisabled=m.role==='assistant'&&m.engine==='codex-cli'&&(!policy.enabled||!policy.aiFallback||!this.agent.configured);
    const validFacts = new Map(this.store.facts().map(f => [f.id,f]));
    const sources=JSON.parse(m.sources);
    const expiredSource = m.role === 'assistant' && sources.some(id => !validFacts.has(id));
    const unsupportedAnswer=m.role==='assistant'&&m.decision==='answer'&&!sources.some(id=>validFacts.has(id)&&!['style','procedure'].includes(validFacts.get(id).category));
    if (!stateOkay || nativeDisabled || m.version !== c.version || m.config_version !== this.store.value('revision') || expiredSource || unsupportedAnswer) {
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?", m.id); return;
    }
    // Recheck source categories at submission, including explicitly approved
    // drafts. A later refund classification requires a human-controlled reply.
    if(m.role==='assistant'&&sources.some(id=>validFacts.get(id)?.category==='refund')){
      this.store.transaction(()=>{
        if(!this.pendingWindow(c.id)){
          const latest=this.store.get("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",c.id);
          if(latest)this.openWindow(c.id,latest.id,this.now());
        }
        const window=this.pendingWindow(c.id);
        if(window)this.handoffWindow(window,'knowledge_requires_human');
        this.store.run("UPDATE messages SET status='cancelled' WHERE id=?",m.id);
      });
      return;
    }
    if (c.channel === 'demo') { this.beginDispatch(c.id, m, 'simulated'); return; }
    if (c.channel === 'web') {
      if (!this.webChatEnabled) { this.store.run("UPDATE messages SET status='failed' WHERE id=?", m.id); return; }
      this.beginDispatch(c.id, m, 'accepted'); return;
    }
    if (!this.liveReady() || Date.now() - c.last_customer_at >= 24 * 60 * 60 * 1000) {
      this.store.run("UPDATE messages SET status='failed' WHERE id=?", m.id);
      this.store.audit('send_gate_blocked', m.id); return;
    }
    // Synchronous state check and sending transition occur before network dispatch.
    // A takeover after this boundary cannot retract a message already in flight.
    if (!this.beginDispatch(c.id, m, 'sending')) return;
    try {
      const result = await this.evolution.send(c.address, m.content);
      this.store.transaction(() => {
        this.store.run("UPDATE messages SET status='accepted', provider_id=? WHERE id=?", result.providerId, m.id);
        this.reconcileReceipts(m.id);
      });
    } catch {
      // No automatic retry: HTTP errors/timeouts may still follow a successful send.
      this.store.run("UPDATE messages SET status='uncertain' WHERE id=?", m.id);
      this.store.audit('send_outcome_unknown', m.id);
    }
  }
  beginDispatch(id, message, status) {
    return this.store.transaction(() => {
      const now = this.now(), window = this.pendingWindow(id);
      // Check again at the synchronous submission transition, not only when
      // generation/approval ran. Queued drafts never finish the response window.
      if (window && window.deadline_at <= now) {
        this.handoffWindow(window, 'deadline', now); return false;
      }
      this.store.run('UPDATE messages SET status=? WHERE id=?', status, message.id);
      if (status === 'sending') this.store.run('UPDATE messages SET provider_instance=? WHERE id=?', this.evolution.instance || null, message.id);
      this.closeWindow(id, message.decision === 'clarify' ? 'waiting_customer' : 'submitted',
        message.decision === 'clarify' ? 'clarification_submitted' : 'reply_submitted', now);
      return true;
    });
  }
  async dispatchQueued() {
    if (this.dispatching || this.stopping || this.updatePaused) return;
    this.dispatching = true;
    try {
      const message = this.localInboxScope
        ? this.store.all("SELECT * FROM messages WHERE status='queued' ORDER BY created_at").find(m=>this.localInboxScope.receive&&this.localInboxScope.manual&&this.localInboxScope.sends.has(m.id))
        : this.store.get("SELECT * FROM messages WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (message) await this.dispatch(message);
    } finally { this.dispatching = false; }
  }
  async tick() {
    if(this.updatePaused)return;
    if (!this.stopping) this.checkDeadlines();
    if (this.stopping) return;
    // A slow generation must not block the independent manual-send lane after
    // takeover. Both lanes still have a single-owner guard.
    if (this.running) { await this.dispatchQueued(); return; }
    this.running = true;
    try {
      const job = this.localInboxScope
        ? this.store.all("SELECT * FROM jobs WHERE state='pending' ORDER BY created_at").find(job=>this.localInboxScope.receive&&this.localInboxScope.jobs.has(job.id))
        : this.store.get("SELECT * FROM jobs WHERE state='pending' ORDER BY created_at LIMIT 1");
      if (job) await this.processJob(job);
      await this.dispatchQueued();
    } finally { this.running = false; }
  }
  start() {
    if (this.timer || this.deadlineTimer) return;
    this.stopping = false;
    this.watchStore();
    this.checkDeadlines();
    // This independent synchronous monitor keeps working while reply()/send()
    // awaits network I/O. A stopped process cannot guarantee a wall-clock SLA.
    this.deadlineTimer = setInterval(() => {
      try { this.checkDeadlines(); } catch { this.store.audit('deadline_monitor_error'); }
    }, this.deadlinePollMs);
    this.timer = setInterval(() => this.tick().catch(() => this.store.audit('worker_error')), 500);
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); clearInterval(this.deadlineTimer);
    this.timer = null; this.deadlineTimer = null;
    this.cancelGeneration('shutdown');
    while (this.running || this.dispatching) await new Promise(resolve => setTimeout(resolve, 20));
    this.unsubscribeStore?.();this.unsubscribeStore=null;
    await this.agent.close?.();
  }
}
