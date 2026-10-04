'use strict';

const SNOWFLAKE = /^\d{17,20}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RETENTION_DAYS = 90;

/**
 * Journal d'activité du panel web : qui s'est connecté, et quelles actions (requêtes POST/PUT/PATCH/DELETE)
 * ont été faites, sur quel module et quel serveur, avec le code de réponse. Les simples consultations ne sont
 * pas journalisées. Conservation : 90 jours.
 */
class ActivityLog {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.timer = null;
  }

  async record({ userId, username, action, path, module = null, guildId = null, status = null }) {
    await this.db.query(
      'INSERT INTO web_activity (user_id, username, action, path, module, guild_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, String(username ?? '').slice(0, 64), action, String(path).slice(0, 200), module, guildId, status, new Date()],
    );
  }

  /** Middleware Express : journalise chaque requête qui modifie quelque chose, une fois la réponse envoyée. */
  middleware() {
    return (req, res, next) => {
      if (!MUTATING.has(req.method)) return next();
      const user = req.session?.user; // lu tout de suite : la déconnexion détruit la session avant la fin de la réponse
      if (!user) return next();
      res.on('finish', () => {
        const path = req.originalUrl.split('?')[0];
        const moduleMatch = /^\/m\/([\w-]+)\//.exec(path);
        const guild = String(req.query?.guild ?? req.body?.guildId ?? '');
        this.record({
          userId: user.id,
          username: user.globalName || user.username,
          action: path === '/auth/logout' ? 'logout' : req.method,
          path,
          module: moduleMatch ? moduleMatch[1] : null,
          guildId: SNOWFLAKE.test(guild) ? guild : null,
          status: res.statusCode,
        }).catch((err) => this.logger.warn('Journal d’activité du panel indisponible', err.message));
      });
      return next();
    };
  }

  /** Entrées les plus récentes ; `userId` force le filtre (un compte non propriétaire ne voit que les siennes). */
  async list({ userId = null, module = null, limit = 50, offset = 0 } = {}) {
    let where = '1 = 1';
    const params = [];
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    if (module) {
      where += ' AND module = ?';
      params.push(module);
    }
    const [rows, count] = await Promise.all([
      this.db.query(`SELECT * FROM web_activity WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      this.db.one(`SELECT COUNT(*) AS n FROM web_activity WHERE ${where}`, params),
    ]);
    return { rows, total: Number(count?.n ?? 0) };
  }

  start() {
    const purge = () =>
      this.db
        .query('DELETE FROM web_activity WHERE created_at < ?', [new Date(Date.now() - RETENTION_DAYS * 86_400_000)])
        .catch((err) => this.logger.warn('Purge du journal d’activité impossible', err.message));
    purge();
    this.timer = setInterval(purge, 24 * 60 * 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { ActivityLog };
