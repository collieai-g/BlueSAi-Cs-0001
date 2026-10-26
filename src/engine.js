import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Full-question matching deliberately does not invent semantic similarity or
// remove interior punctuation (for example, decimal points and product codes).
export const normalizeFaqQuestion = text => typeof text === 'string'
  ? text.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(/[?？!！。]+$/gu, '').trim().toLowerCase() : '';

export class Engine {
  constructor(store, agent, evolution, { now = Date.now, responseTimeoutMs = 30000, deadlinePollMs = 250 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > 86400000 ||
        !Number.isSafeInteger(deadlinePollMs) || deadlinePollMs < 1 || deadlinePollMs > 60000) throw new Error('INVALID_DEADLINE_OPTIONS');
    this.store = store; this.agent = agent; this.evolution = evolution;
    this.now = now; this.responseTimeoutMs = responseTimeoutMs; this.deadlinePollMs = deadlinePollMs;
    this.running = false; this.dispatching = false; this.stopping = false; this.webChatEnabled = false;
    store.recover();
    for (const m of store.all("SELECT id FROM messages WHERE provider_id IS NOT NULL AND provider_instance IS NOT NULL AND role IN ('assistant','staff')")) this.reconcileReceipts(m.id);
    this.checkDeadlines();
  }
  requireConversation(id) {
    const c = this.store.conversation(id);
    if (!c) throw new ServiceError('找不到對話。', 404);
    return c;
  }
  inboxPolicy() { return this.store.value('inbox_policy'); }
  inboxStatus() {
    const pending = this.store.all(`SELECT h.id,h.conversation_id,h.reason,h.created_at FROM handoff_tasks h
      JOIN conversations c ON c.id=h.conversation_id
      WHERE h.status='pending' AND c.state IN ('waiting','human')
      AND h.rowid=(SELECT MAX(h2.rowid) FROM handoff_tasks h2 WHERE h2.conversation_id=h.conversation_id AND h2.status='pending')
      ORDER BY h.created_at DESC LIMIT 200`).map(row=>({id:row.id,conversationId:row.conversation_id,reason:row.reason,createdAt:row.created_at}));
    const pendingCount = this.store.get(`SELECT COUNT(DISTINCT h.conversation_id) AS n FROM handoff_tasks h
      JOIN conversations c ON c.id=h.conversation_id WHERE h.status='pending' AND c.state IN ('waiting','human')`).n;
    return { policy: this.inboxPolicy(), pendingCount, pending, hasMore: pendingCount > pending.length,
      notification: { scope: 'local_card', externalNotified: false } };
  }
  configureInbox(input) {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.automaticKnowledge !== 'boolean') throw new ServiceError('請確認收件箱及知識庫自動回覆設定。');
    return this.store.transaction(()=>{
      const previous = this.inboxPolicy();
      const next = { enabled: input.enabled, automaticKnowledge: input.automaticKnowledge };
      if (JSON.stringify(previous) === JSON.stringify(next)) return this.inboxStatus();
      const unanswered = next.enabled ? this.store.all(`SELECT DISTINCT c.id FROM conversations c
        WHERE c.state='ai' AND (EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.state IN ('pending','running'))
          OR EXISTS(SELECT 1 FROM response_windows w WHERE w.conversation_id=c.id AND w.status='pending'))`) : [];
      this.store.set('inbox_policy', next); this.store.revise();
      if (next.enabled) {
        this.store.run("UPDATE jobs SET state='done' WHERE state IN ('pending','running')");
        for (const row of unanswered) {
          this.closeWindow(row.id, 'cancelled', 'knowledge_mode_enabled');
          const message = this.store.get("SELECT * FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1", row.id);
          if (message) this.answerFromKnowledge(this.store.conversation(row.id), message);
        }
      }
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
      this.store.revise(); this.store.audit(input.approved ? 'faq_approved' : 'faq_proposed', id);
      return { id, knowledgeId, question, answer, approved: input.approved };
    });
  }
  listFaq() {
    return this.store.all(`SELECT r.id,r.knowledge_id,r.question,k.content,k.approved,k.expires_at FROM faq_rules r
      JOIN knowledge k ON k.id=r.knowledge_id ORDER BY r.created_at DESC,r.rowid DESC`).map(row=>({
      id:row.id,knowledgeId:row.knowledge_id,question:row.question,answer:row.content,approved:Boolean(row.approved),expiresAt:row.expires_at,
      usable:Boolean(row.approved && (row.expires_at == null || row.expires_at > Date.now())) }));
  }
  answerFromKnowledge(c, message, forcedReason = '') {
    if (!c || c.channel === 'whatsapp_self_test' || c.state !== 'ai') return;
    if (this.store.get("SELECT id FROM messages WHERE conversation_id=? AND version=? AND engine='knowledge' AND status<>'cancelled'", c.id, c.version)) return;
    const matches = this.store.all(`SELECT k.* FROM faq_rules r JOIN knowledge k ON k.id=r.knowledge_id
      WHERE r.normalized_question=? AND k.approved=1 AND (k.expires_at IS NULL OR k.expires_at>?)`, normalizeFaqQuestion(message.content), this.now());
    let reason = forcedReason;
    if (!reason && (/退款|退貨|refund|例外|exception/iu.test(message.content) || matches.some(row=>row.category==='refund'))) reason = 'knowledge_requires_human';
    if (!reason && matches.length !== 1) reason = matches.length ? 'knowledge_conflict' : 'knowledge_missing';
    if (reason) {
      this.openWindow(c.id, message.id, this.now());
      const window = this.pendingWindow(c.id);
      if (window) this.handoffWindow(window, reason);
      return;
    }
    const automatic = this.inboxPolicy().automaticKnowledge &&
      (c.channel === 'demo' || (c.channel === 'web' ? this.webChatEnabled : this.liveReady()));
    this.store.addMessage(c.id, 'assistant', matches[0].content, {
      status: automatic ? 'queued' : 'draft', sources: [matches[0].id], decision: 'answer', engine: 'knowledge',
    });
    this.store.audit(automatic ? 'knowledge_reply_queued' : 'knowledge_reply_drafted', c.id);
  }
  invalidate(id) {
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
    if (conversation.channel === 'whatsapp_self_test') throw new ServiceError('WhatsApp 自傳測試只供讀取，不提供接手、回覆或交回自動處理。',409);
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
    if (channel === 'whatsapp_self_test') throw new ServiceError('自傳測試須使用獨立的只讀收件路線。',409);
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
      if (this.inboxPolicy().enabled) {
        const current = this.store.conversation(c.id);
        const reason = review ? 'incoming_needs_review' : /真人|人工|投訴|human|complaint/iu.test(text) ? 'customer_requests_human' : '';
        this.answerFromKnowledge(current, this.store.get('SELECT * FROM messages WHERE id=?', id), reason);
        return { conversationId: c.id, messageId: id, duplicate: false };
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
  receiveSelfTest({address,eventId,text,timestamp}) {
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
      this.store.run("UPDATE conversations SET state='self_test',name='WhatsApp 自傳測試（只讀）' WHERE id=?",c.id);
      const messageId=this.store.addMessage(c.id,'user',text,{status:'received',providerId:eventId,
        providerInstance:this.evolution.instance || null,engine:'whatsapp-self-test',decision:'test_only'});
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
      this.store.run(`INSERT INTO channel_activity(instance,last_receipt_at) VALUES (?,?)
        ON CONFLICT(instance) DO UPDATE SET last_receipt_at=excluded.last_receipt_at`, instance, now);
      const message = this.store.get(`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.provider_instance=? AND m.provider_id=? AND c.channel='evolution' AND c.address=? AND m.role IN ('assistant','staff')`, instance, providerId, address);
      if (message) this.reconcileReceipts(message.id);
      return { duplicate: result.changes === 0, matched: Boolean(message) };
    });
  }
  reconcileReceipts(messageId) {
    const m = this.store.get(`SELECT m.*,c.address,c.channel FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`, messageId);
    if (!m || m.channel !== 'evolution' || !m.provider_id || !m.provider_instance || !['assistant','staff'].includes(m.role)) return;
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
    this.checkDeadlines();
    const c = this.store.conversation(job.conversation_id);
    if (!c || c.channel === 'whatsapp_self_test' || c.state !== 'ai' || c.version !== job.version) {
      this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id); return;
    }
    if (this.inboxPolicy().enabled) {
      this.store.transaction(()=>{
        const message = this.store.get('SELECT * FROM messages WHERE id=?', job.id);
        if (message) this.answerFromKnowledge(c, message);
        this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id);
      });
      return;
    }
    const revision = this.store.value('revision');
    this.store.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
    try {
      const result = await this.agent.reply({ profile: this.store.value('profile'), facts: this.store.facts(), history: this.store.history(c.id) });
      // Enforce the boundary even when no monitor tick occurred during the await.
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        if (!this.inboxPolicy().enabled && current?.state === 'ai' && current.version === c.version && revision === this.store.value('revision')) {
          const settings = this.store.value('settings');
          const canAuto = settings.mode === 'auto' && result.decision === 'answer' &&
            (c.channel === 'demo' || (this.agent.configured && (c.channel === 'web' ? this.webChatEnabled : this.liveReady())));
          if (result.decision === 'handoff') {
            const window = this.pendingWindow(c.id);
            if (window) this.handoffWindow(window, 'agent_requests_human');
            else this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
          }
          this.store.addMessage(c.id, 'assistant', result.text, {
            status: result.decision === 'handoff' ? 'draft' : canAuto ? 'queued' : 'draft',
            sources: result.sourceIds, decision: result.decision, engine: result.engine,
          });
          if (result.decision === 'handoff') this.store.audit('agent_requests_human', c.id);
        }
        // A knowledge edit during generation should regenerate, not silently lose
        // a still-current customer request. Takeover/newer input remains final.
        const next = !this.inboxPolicy().enabled && current?.state === 'ai' && current.version === c.version && revision !== this.store.value('revision') ? 'pending' : 'done';
        this.store.run('UPDATE jobs SET state=? WHERE id=?', next, job.id);
      });
    } catch {
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        const stillCurrent = !this.inboxPolicy().enabled && current?.state === 'ai' && current.version === c.version;
        this.store.run('UPDATE jobs SET state=? WHERE id=?', stillCurrent ? 'failed' : 'done', job.id);
        if (stillCurrent) {
          const window = this.pendingWindow(c.id);
          if (window) this.handoffWindow(window, 'generation_failed');
          else this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
          this.store.addMessage(c.id, 'system', 'AI 暫時未能完成回覆，請由人工處理。', { status: 'failed' });
        }
        this.store.audit('generation_failed', c.id);
      });
    }
  }
  channelReady() { return Boolean(this.evolution.configured && this.evolution.deliveryEnabled); }
  liveReady() {
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
    if (c?.channel === 'whatsapp_self_test') {
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?",m.id);
      this.store.audit('whatsapp_self_test_send_blocked',m.id);return;
    }
    const stateOkay = m.role === 'staff' ? c?.state === 'human' : c?.state === 'ai';
    const validFacts = new Set(this.store.facts().map(f => f.id));
    const expiredSource = m.role === 'assistant' && JSON.parse(m.sources).some(id => !validFacts.has(id));
    if (!stateOkay || m.version !== c.version || m.config_version !== this.store.value('revision') || expiredSource) {
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?", m.id); return;
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
    if (this.dispatching || this.stopping) return;
    this.dispatching = true;
    try {
      const message = this.store.get("SELECT * FROM messages WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (message) await this.dispatch(message);
    } finally { this.dispatching = false; }
  }
  async tick() {
    if (!this.stopping) this.checkDeadlines();
    if (this.stopping) return;
    // A slow generation must not block the independent manual-send lane after
    // takeover. Both lanes still have a single-owner guard.
    if (this.running) { await this.dispatchQueued(); return; }
    this.running = true;
    try {
      const job = this.store.get("SELECT * FROM jobs WHERE state='pending' ORDER BY created_at LIMIT 1");
      if (job) await this.processJob(job);
      await this.dispatchQueued();
    } finally { this.running = false; }
  }
  start() {
    if (this.timer || this.deadlineTimer) return;
    this.stopping = false;
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
    while (this.running || this.dispatching) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
