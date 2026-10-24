import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Engine {
  constructor(store, agent, evolution, { now = Date.now, responseTimeoutMs = 30000, deadlinePollMs = 250 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > 86400000 ||
        !Number.isSafeInteger(deadlinePollMs) || deadlinePollMs < 1 || deadlinePollMs > 60000) throw new Error('INVALID_DEADLINE_OPTIONS');
    this.store = store; this.agent = agent; this.evolution = evolution;
    this.now = now; this.responseTimeoutMs = responseTimeoutMs; this.deadlinePollMs = deadlinePollMs;
    this.running = false; this.dispatching = false; this.stopping = false;
    store.recover();
    this.checkDeadlines();
  }
  requireConversation(id) {
    const c = this.store.conversation(id);
    if (!c) throw new ServiceError('找不到對話。', 404);
    return c;
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
    this.requireConversation(id);
    this.store.transaction(() => {
      this.invalidate(id);
      this.closeWindow(id, 'cancelled', state === 'ai' ? 'resume' : 'manual_takeover');
      this.store.run("UPDATE jobs SET state='done' WHERE conversation_id=? AND state IN ('pending','running')", id);
      this.store.run('UPDATE conversations SET state=? WHERE id=?', state, id);
      this.store.audit(state === 'ai' ? 'resume' : 'takeover', id);
    });
  }
  receive({ channel = 'demo', address = randomUUID(), name = '試聊客人', eventId = randomUUID(), text, timestamp = Date.now(), review = false }) {
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
      const id = this.store.addMessage(c.id, 'user', text, { providerId: channel === 'evolution' ? eventId : null });
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
  outgoingEcho(event) {
    // Correlated AI echoes must not take over. Unknown outgoing traffic is conservative.
    if (this.store.get('SELECT id FROM messages WHERE provider_id=? AND role IN (\'assistant\',\'staff\')', event.eventId)) return;
    let c = this.store.get("SELECT * FROM conversations WHERE channel='evolution' AND address=?", event.address);
    if (!c) return;
    if (this.store.get('SELECT id FROM events WHERE id=?', `outgoing:${event.eventId}`)) return;
    this.takeover(c.id);
    this.store.transaction(() => {
      this.store.run('INSERT INTO events VALUES (?,?)', `outgoing:${event.eventId}`, Date.now());
      this.store.addMessage(c.id, 'staff', event.text, { status: 'accepted', providerId: event.eventId });
    });
  }
  async processJob(job) {
    this.checkDeadlines();
    const c = this.store.conversation(job.conversation_id);
    if (!c || c.state !== 'ai' || c.version !== job.version) {
      this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id); return;
    }
    const revision = this.store.value('revision');
    this.store.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
    try {
      const result = await this.agent.reply({ profile: this.store.value('profile'), facts: this.store.facts(), history: this.store.history(c.id) });
      // Enforce the boundary even when no monitor tick occurred during the await.
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        if (current?.state === 'ai' && current.version === c.version && revision === this.store.value('revision')) {
          const settings = this.store.value('settings');
          const canAuto = settings.mode === 'auto' && result.decision === 'answer' &&
            (c.channel === 'demo' || (this.agent.configured && this.liveReady()));
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
        const next = current?.state === 'ai' && current.version === c.version && revision !== this.store.value('revision') ? 'pending' : 'done';
        this.store.run('UPDATE jobs SET state=? WHERE id=?', next, job.id);
      });
    } catch {
      this.checkDeadlines();
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        const stillCurrent = current?.state === 'ai' && current.version === c.version;
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
  liveReady() {
    const p = this.store.value('profile'); const settings = this.store.value('settings');
    return Boolean(this.evolution.configured && this.evolution.deliveryEnabled && p.name && p.service && settings.handoffContact);
  }
  approve(messageId, text) {
    this.checkDeadlines();
    const m = this.store.get('SELECT * FROM messages WHERE id=?', messageId);
    if (!m || m.status !== 'draft') throw new ServiceError('草稿已變更，請重新查看。', 409);
    const c = this.requireConversation(m.conversation_id);
    if (m.version !== c.version || m.config_version !== this.store.value('revision')) throw new ServiceError('資料已更新，這份草稿不能再發送。', 409);
    if (c.state !== 'ai') throw new ServiceError('請在人工回覆欄確認內容並發送。', 409);
    if (c.channel === 'evolution' && !this.liveReady()) throw new ServiceError('尚未完成真實發送設定。', 409);
    this.store.run("UPDATE messages SET content=?, status='queued' WHERE id=?", text || m.content, m.id);
    this.store.audit('approve_draft', m.id);
  }
  manualReply(id, text) {
    const c = this.requireConversation(id);
    if (c.state !== 'human') throw new ServiceError('請先接手對話。', 409);
    if (c.channel === 'evolution' && !this.liveReady()) throw new ServiceError('尚未完成真實發送設定。', 409);
    return this.store.addMessage(id, 'staff', text, { status: 'queued' });
  }
  async dispatch(m) {
    this.checkDeadlines();
    // A queued object may be stale after a deadline, takeover or another dispatch.
    m = this.store.get('SELECT * FROM messages WHERE id=?', m.id);
    if (!m || m.status !== 'queued') return;
    const c = this.store.conversation(m.conversation_id);
    const stateOkay = m.role === 'staff' ? c?.state === 'human' : c?.state === 'ai';
    const validFacts = new Set(this.store.facts().map(f => f.id));
    const expiredSource = m.role === 'assistant' && JSON.parse(m.sources).some(id => !validFacts.has(id));
    if (!stateOkay || m.version !== c.version || m.config_version !== this.store.value('revision') || expiredSource) {
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?", m.id); return;
    }
    if (c.channel === 'demo') { this.beginDispatch(c.id, m, 'simulated'); return; }
    if (!this.liveReady() || Date.now() - c.last_customer_at >= 24 * 60 * 60 * 1000) {
      this.store.run("UPDATE messages SET status='failed' WHERE id=?", m.id);
      this.store.audit('send_gate_blocked', m.id); return;
    }
    // Synchronous state check and sending transition occur before network dispatch.
    // A takeover after this boundary cannot retract a message already in flight.
    if (!this.beginDispatch(c.id, m, 'sending')) return;
    try {
      const result = await this.evolution.send(c.address, m.content);
      this.store.run("UPDATE messages SET status='accepted', provider_id=? WHERE id=?", result.providerId, m.id);
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
