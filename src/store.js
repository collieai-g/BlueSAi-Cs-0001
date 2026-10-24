import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const defaults = {
  profile: { name: '', industry: '', service: '', instructions: '', tone: 'friendly' },
  settings: { mode: 'review', handoffContact: '' },
  revision: 1,
};

export class Store {
  constructor(path) {
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
      if (latest > 2) throw new Error('DATABASE_SCHEMA_NEWER_THAN_SERVICE');
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
    });
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
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
    return this.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, rowid', id)
      .map(m => ({ ...m, sources: JSON.parse(m.sources) }));
  }
  history(id) {
    return this.messages(id).filter(m => m.role === 'user' || (['assistant','staff'].includes(m.role) && ['simulated','accepted','delivered','read'].includes(m.status)))
      .slice(-24).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  }
  addMessage(conversationId, role, content, options = {}) {
    const c = this.conversation(conversationId);
    const id = randomUUID();
    this.run(`INSERT INTO messages(id,conversation_id,role,content,status,provider_id,version,config_version,sources,decision,engine,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, role, content, options.status || 'received', options.providerId || null,
      c.version, this.value('revision'), JSON.stringify(options.sources || []), options.decision || null, options.engine || null, Date.now());
    this.run('UPDATE conversations SET updated_at=? WHERE id=?', Date.now(), c.id);
    return id;
  }
  recover() {
    this.run("UPDATE jobs SET state='pending' WHERE state='running'");
    // A crash after dispatch cannot establish whether the provider accepted it.
    this.run("UPDATE messages SET status='uncertain' WHERE status='sending'");
  }
  close() { this.db.close(); }
}
