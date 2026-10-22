import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Engine {
  constructor(store, agent, evolution) {
    this.store = store; this.agent = agent; this.evolution = evolution;
    this.running = false; this.stopping = false;
    store.recover();
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
  takeover(id, state = 'human') {
    this.requireConversation(id);
    this.store.transaction(() => {
      this.invalidate(id);
      this.store.run('UPDATE conversations SET state=? WHERE id=?', state, id);
      this.store.audit(state === 'ai' ? 'resume' : 'takeover', id);
    });
  }
  receive({ channel = 'demo', address = randomUUID(), name = '試聊客人', eventId = randomUUID(), text, timestamp = Date.now(), review = false }) {
    return this.store.transaction(() => {
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
      if (review || /真人|人工|投訴|human|complaint/i.test(text)) {
        this.store.run("UPDATE conversations SET state=CASE WHEN state='human' THEN state ELSE 'waiting' END WHERE id=?", c.id);
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
    const c = this.store.conversation(job.conversation_id);
    if (!c || c.state !== 'ai' || c.version !== job.version) {
      this.store.run("UPDATE jobs SET state='done' WHERE id=?", job.id); return;
    }
    const revision = this.store.value('revision');
    this.store.run("UPDATE jobs SET state='running' WHERE id=?", job.id);
    try {
      const result = await this.agent.reply({ profile: this.store.value('profile'), facts: this.store.facts(), history: this.store.history(c.id) });
      this.store.transaction(() => {
        const current = this.store.conversation(c.id);
        if (current.state === 'ai' && current.version === c.version && revision === this.store.value('revision')) {
          const settings = this.store.value('settings');
          const canAuto = settings.mode === 'auto' && result.decision === 'answer' &&
            (c.channel === 'demo' || (this.agent.configured && this.liveReady()));
          this.store.addMessage(c.id, 'assistant', result.text, {
            status: result.decision === 'handoff' ? 'draft' : canAuto ? 'queued' : 'draft',
            sources: result.sourceIds, decision: result.decision, engine: result.engine,
          });
          if (result.decision === 'handoff') {
            this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
            this.store.audit('agent_requests_human', c.id);
          }
        }
        // A knowledge edit during generation should regenerate, not silently lose
        // a still-current customer request. Takeover/newer input remains final.
        const next = current.state === 'ai' && current.version === c.version && revision !== this.store.value('revision') ? 'pending' : 'done';
        this.store.run('UPDATE jobs SET state=? WHERE id=?', next, job.id);
      });
    } catch {
      this.store.transaction(() => {
        this.store.run("UPDATE jobs SET state='failed' WHERE id=?", job.id);
        const current = this.store.conversation(c.id);
        if (current.state === 'ai' && current.version === c.version) {
          this.store.run("UPDATE conversations SET state='waiting' WHERE id=?", c.id);
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
    const c = this.store.conversation(m.conversation_id);
    const stateOkay = m.role === 'staff' ? c?.state === 'human' : c?.state === 'ai';
    const validFacts = new Set(this.store.facts().map(f => f.id));
    const expiredSource = m.role === 'assistant' && JSON.parse(m.sources).some(id => !validFacts.has(id));
    if (!stateOkay || m.version !== c.version || m.config_version !== this.store.value('revision') || expiredSource) {
      this.store.run("UPDATE messages SET status='cancelled' WHERE id=?", m.id); return;
    }
    if (c.channel === 'demo') { this.store.run("UPDATE messages SET status='simulated' WHERE id=?", m.id); return; }
    if (!this.liveReady() || Date.now() - c.last_customer_at >= 24 * 60 * 60 * 1000) {
      this.store.run("UPDATE messages SET status='failed' WHERE id=?", m.id);
      this.store.audit('send_gate_blocked', m.id); return;
    }
    // Synchronous state check and sending transition occur before network dispatch.
    // A takeover after this boundary cannot retract a message already in flight.
    this.store.run("UPDATE messages SET status='sending' WHERE id=?", m.id);
    try {
      const result = await this.evolution.send(c.address, m.content);
      this.store.run("UPDATE messages SET status='accepted', provider_id=? WHERE id=?", result.providerId, m.id);
    } catch {
      // No automatic retry: HTTP errors/timeouts may still follow a successful send.
      this.store.run("UPDATE messages SET status='uncertain' WHERE id=?", m.id);
      this.store.audit('send_outcome_unknown', m.id);
    }
  }
  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const job = this.store.get("SELECT * FROM jobs WHERE state='pending' ORDER BY created_at LIMIT 1");
      if (job) await this.processJob(job);
      const message = this.store.get("SELECT * FROM messages WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (message) await this.dispatch(message);
    } finally { this.running = false; }
  }
  start() { this.timer = setInterval(() => this.tick().catch(() => this.store.audit('worker_error')), 500); }
  async stop() {
    this.stopping = true; clearInterval(this.timer);
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
