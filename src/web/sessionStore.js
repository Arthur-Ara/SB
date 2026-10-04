'use strict';

const session = require('express-session');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Store express-session persistant dans MySQL (table web_sessions). */
class MySQLSessionStore extends session.Store {
  constructor(db, { ttlMs = DEFAULT_TTL_MS, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.timer.unref();
  }

  expiry(sess) {
    const expires = sess?.cookie?.expires;
    return expires ? new Date(expires) : new Date(Date.now() + this.ttlMs);
  }

  get(sid, callback) {
    this.db
      .one('SELECT data FROM web_sessions WHERE sid = ? AND expires_at > ?', [sid, new Date()])
      .then((row) => callback(null, row ? JSON.parse(row.data) : null))
      .catch((err) => callback(err));
  }

  set(sid, sess, callback = () => {}) {
    this.db
      .query(
        `INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
        [sid, JSON.stringify(sess), this.expiry(sess)],
      )
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  touch(sid, sess, callback = () => {}) {
    this.db
      .query('UPDATE web_sessions SET expires_at = ? WHERE sid = ?', [this.expiry(sess), sid])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  destroy(sid, callback = () => {}) {
    this.db
      .query('DELETE FROM web_sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  cleanup() {
    this.db.query('DELETE FROM web_sessions WHERE expires_at <= ?', [new Date()]).catch(() => {});
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { MySQLSessionStore };
