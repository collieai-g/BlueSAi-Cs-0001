import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const defaults = {
  profile: { name: '', industry: '', service: '', instructions: '', tone: 'friendly' },
  settings: { mode: 'review', handoffContact: '' },
  inbox_policy: { enabled: false, automaticKnowledge: false, aiFallback: false, automaticAi: false },
  reply_provider: { provider: 'environment' },
  knowledge_learning: { automaticAnalysis: false },
  revision: 1,
};

export class Store {
  constructor(path) {
    this.listeners = new Set(); this.changeQueued = false; this.closed = false;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ai', version INTEGER NOT NULL DEFAULT 0,
        last_customer_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        UNIQUE(channel, address));
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT,
        version INTEGER NOT NULL, config_version INTEGER NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
        decision TEXT, engine TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider_id);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS training_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
    for (const [key, value] of Object.entries(defaults)) {
      this.run('INSERT OR IGNORE INTO config VALUES (?, ?)', key, JSON.stringify(value));
    }
  }
  migrate() {
    // Additive migrations leave existing conversations, messages and profiles intact.
    // In particular, legacy messages do not acquire retroactive response deadlines.
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const latest = this.get('SELECT MAX(version) AS version FROM schema_migrations').version || 0;
      if (latest > 7) throw new Error('DATABASE_SCHEMA_NEWER_THAN_SERVICE');
      if (latest < 1) {
        this.db.exec(`
          CREATE TABLE response_windows (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            first_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            opened_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','submitted','waiting_customer','handed_off','cancelled')),
            resolved_at INTEGER, reason TEXT);
          CREATE UNIQUE INDEX response_windows_one_pending ON response_windows(conversation_id) WHERE status='pending';
          CREATE INDEX response_windows_due ON response_windows(deadline_at) WHERE status='pending';
          CREATE TABLE handoff_tasks (
            id TEXT PRIMARY KEY,
            window_id TEXT NOT NULL UNIQUE REFERENCES response_windows(id) ON DELETE CASCADE,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
        `);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 1, Date.now());
      }
      if (latest < 2) {
        this.db.exec(`
          CREATE TABLE dot_tasks (
            id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
            instruction TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('prepared','copied','opened','host_submitted','result_saved','cancelled')),
            version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            revision INTEGER NOT NULL, verification_code TEXT NOT NULL,
            snapshot TEXT NOT NULL, prompt TEXT NOT NULL, result_text TEXT);
          CREATE INDEX dot_tasks_newest ON dot_tasks(created_at DESC);
        `);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 2, Date.now());
      }
      if (latest < 3) {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN provider_instance TEXT;
          CREATE TABLE provider_receipts (
            instance TEXT NOT NULL, provider_id TEXT NOT NULL, address TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('accepted','delivered','read','failed')),
            received_at INTEGER NOT NULL,
            PRIMARY KEY(instance,provider_id,address,status));
          CREATE TABLE channel_activity (
            instance TEXT PRIMARY KEY, last_incoming_at INTEGER, last_receipt_at INTEGER);
        `);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 3, Date.now());
      }
      if (latest < 4) {
        this.db.exec(`
          CREATE TABLE web_chat_sessions (
            token_hash TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            rate_window INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX web_chat_sessions_expiry ON web_chat_sessions(expires_at);
        `);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 4, Date.now());
      }
      if (latest < 5) {
        this.db.exec(`CREATE TABLE faq_rules (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
          question TEXT NOT NULL, normalized_question TEXT NOT NULL,
          created_at INTEGER NOT NULL);
          CREATE INDEX faq_rules_question ON faq_rules(normalized_question);`);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 5, Date.now());
      }
      if (latest < 6) {
        this.db.exec(`CREATE TABLE self_test_reply_links (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          input_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          grant_id TEXT NOT NULL, request_provider_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('input','faq','manual')),
          operation_id TEXT UNIQUE);
          CREATE UNIQUE INDEX self_test_one_faq ON self_test_reply_links(input_message_id,grant_id) WHERE kind='faq';`);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 6, Date.now());
      }
      if (latest < 7) {
        this.db.exec(`CREATE TABLE learning_cases (
          id TEXT PRIMARY KEY,
          source_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          source_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','analyzing','analyzed','failed')),
          error_code TEXT, created_at INTEGER NOT NULL, analyzed_at INTEGER);
          CREATE TABLE learning_proposals (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES learning_cases(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('fact','procedure','style')),
          title TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL, rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL, questions_json TEXT NOT NULL, proposal_digest TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
          knowledge_id TEXT REFERENCES knowledge(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL, reviewed_at INTEGER,
          UNIQUE(case_id,proposal_digest));
          CREATE INDEX learning_cases_status ON learning_cases(status,created_at);
          CREATE INDEX learning_proposals_status ON learning_proposals(status,created_at);`);
        this.run('INSERT INTO schema_migrations VALUES (?,?)', 7, Date.now());
      }
    });
  }
  run(sql, ...args) {
    const result = this.db.prepare(sql).run(...args);
    // A change hint carries no customer data. Run listeners after the synchronous
    // transaction finishes; even a rollback only asks clients to read fresh state.
    if (this.listeners.size && !this.changeQueued) {
      this.changeQueued = true;
      queueMicrotask(() => {
        this.changeQueued = false;
        if (!this.closed) for (const listener of this.listeners) { try { listener(); } catch {} }
      });
    }
    return result;
  }
  subscribe(listener) {
    if (this.closed || typeof listener !== 'function') throw new Error('INVALID_STORE_SUBSCRIPTION');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  value(key) { return JSON.parse(this.get('SELECT value FROM config WHERE key=?', key).value); }
  set(key, value) { this.run('UPDATE config SET value=? WHERE key=?', JSON.stringify(value), key); }
  audit(action, target = '') { this.run('INSERT INTO audit(action,target,created_at) VALUES (?,?,?)', action, target, Date.now()); }
  revise() {
    this.set('revision', this.value('revision') + 1);
    this.run("UPDATE messages SET status='cancelled' WHERE role='assistant' AND status IN ('draft','queued')");
  }
  facts(now = Date.now()) {
    return this.all('SELECT * FROM knowledge WHERE approved=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at', now);
  }
  conversation(id) { return this.get('SELECT * FROM conversations WHERE id=?', id); }
  conversations() {
    return this.all(`SELECT c.*, (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS preview,
      (SELECT count(*) FROM messages WHERE conversation_id=c.id AND status IN ('draft','uncertain','failed')) AS pending
      FROM conversations c ORDER BY updated_at DESC LIMIT 200`);
  }
  messages(id) {
    return this.all(`SELECT m.*,s.operation_id FROM messages m LEFT JOIN self_test_reply_links s ON s.message_id=m.id
      WHERE m.conversation_id=? ORDER BY m.created_at,m.rowid`, id)
      .map(({operation_id,...m}) => ({ ...m, sources: JSON.parse(m.sources), ...(operation_id?{operation_id}:{}) }));
  }
  history(id) {
    return this.messages(id).filter(m => m.role === 'user' || (['assistant','staff'].includes(m.role) && ['simulated','accepted','delivered','read'].includes(m.status)))
      .slice(-24).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  }
  addMessage(conversationId, role, content, options = {}) {
    const c = this.conversation(conversationId);
    const id = randomUUID();
    this.run(`INSERT INTO messages(id,conversation_id,role,content,status,provider_id,version,config_version,sources,decision,engine,created_at,provider_instance)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, role, content, options.status || 'received', options.providerId || null,
      c.version, this.value('revision'), JSON.stringify(options.sources || []), options.decision || null, options.engine || null, Date.now(), options.providerInstance || null);
    this.run('UPDATE conversations SET updated_at=? WHERE id=?', Date.now(), c.id);
    return id;
  }
  recover() {
    this.run("UPDATE jobs SET state='pending' WHERE state='running'");
    // A crash after dispatch cannot establish whether the provider accepted it.
    this.run("UPDATE messages SET status='uncertain' WHERE status='sending'");
  }
  close() { this.closed = true; this.listeners.clear(); this.db.close(); }
}
