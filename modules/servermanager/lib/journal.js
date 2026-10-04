'use strict';

const AUDIT_WINDOW_MS = 30_000;

/**
 * Journal des modifications du serveur. Les événements Discord (salon/rôle créé, modifié, supprimé)
 * fournissent l'état avant/après ; l'auteur vient du journal d'audit, reçu séparément en temps réel
 * (dans un ordre indéterminé) : on le mémorise quelques secondes pour les deux cas de figure.
 */
class Journal {
  constructor({ db, logger, store }) {
    this.db = db;
    this.logger = logger;
    this.store = store;
    this.recentAudit = new Map(); // `${kind}:${targetId}` → [{ executorId, at }]
    this.paused = new Map(); // guildId → timestamp de fin de pause
    this.tracked = new Set(); // serveurs dont le début de couverture est déjà mémorisé
  }

  /** Suspend la journalisation d'un serveur (pendant un rollback, pour ne pas journaliser ses propres actions). */
  pause(guildId, ms) {
    this.paused.set(guildId, Date.now() + ms);
  }

  isPaused(guildId) {
    const until = this.paused.get(guildId);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.paused.delete(guildId);
    return false;
  }

  rememberAudit(kind, targetId, executorId) {
    const key = `${kind}:${targetId}`;
    const now = Date.now();
    const list = (this.recentAudit.get(key) ?? []).filter((entry) => now - entry.at < AUDIT_WINDOW_MS);
    list.push({ executorId, at: now });
    this.recentAudit.set(key, list);
    if (this.recentAudit.size > 5000) {
      for (const [k, entries] of this.recentAudit) {
        if (!entries.some((entry) => now - entry.at < AUDIT_WINDOW_MS)) this.recentAudit.delete(k);
      }
    }
  }

  executorFor(kind, targetId) {
    const list = this.recentAudit.get(`${kind}:${targetId}`);
    if (!list?.length) return null;
    const last = list[list.length - 1];
    return Date.now() - last.at < AUDIT_WINDOW_MS ? last.executorId : null;
  }

  /** Ajoute une modification au journal ; renvoie son identifiant. */
  async record({ guildId, kind, op, targetId, roleId = null, executorId = null, label = '', before = null, after = null }) {
    try {
      if (!this.tracked.has(guildId)) {
        this.tracked.add(guildId);
        await this.store.ensureTrackingSince(guildId);
      }
      const result = await this.db.query(
        `INSERT INTO sm_changes (guild_id, kind, op, target_id, role_id, executor_id, label, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          kind,
          op,
          targetId,
          roleId,
          executorId ?? this.executorFor(kind, targetId),
          String(label).slice(0, 120),
          before ? JSON.stringify(before) : null,
          after ? JSON.stringify(after) : null,
          new Date(),
        ],
      );
      return result.insertId;
    } catch (err) {
      this.logger.error(`Journalisation impossible (${kind}/${op} ${targetId})`, err);
      return null;
    }
  }

  /** Complète l'auteur des modifications récentes d'un objet quand son entrée d'audit arrive après l'événement. */
  async attachExecutor(guildId, kind, targetId, executorId) {
    try {
      await this.db.query(
        `UPDATE sm_changes SET executor_id = ?
          WHERE guild_id = ? AND kind = ? AND target_id = ? AND executor_id IS NULL AND created_at >= ?`,
        [executorId, guildId, kind, targetId, new Date(Date.now() - AUDIT_WINDOW_MS)],
      );
    } catch (err) {
      this.logger.warn(`Attribution de l'auteur impossible (${kind} ${targetId})`, err.message);
    }
  }

  /** Supprime les entrées plus anciennes que la durée de conservation. */
  async purge(retentionDays) {
    const limit = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.db.query('DELETE FROM sm_changes WHERE created_at < ?', [limit]);
    return result.affectedRows ?? 0;
  }
}

module.exports = { Journal };
