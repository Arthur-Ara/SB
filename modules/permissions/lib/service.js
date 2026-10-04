'use strict';

function mapOf(parent, key) {
  if (!parent.has(key)) parent.set(key, new Map());
  return parent.get(key);
}

const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > ?)';

/** Clé de règle « toutes les commandes du module » (ex. « moderation.* »). */
function wildcardOf(module) {
  return `${module}.*`;
}

/** Module visé par un joker « module.* », ou null pour une commande ordinaire. */
function wildcardModule(name) {
  return typeof name === 'string' && name.endsWith('.*') ? name.slice(0, -2) : null;
}

/** Plus proche échéance d'une liste de lignes (Infinity si aucune règle temporaire) : le cache devient périmé à cette date. */
function nextExpiry(rows) {
  let next = Infinity;
  for (const row of rows) if (row.expires_at) next = Math.min(next, new Date(row.expires_at).getTime());
  return next;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Règles de permissions d'un serveur, mises en cache mémoire (invalidées à chaque modification et à la
 * première échéance d'un accord temporaire ; le planificateur supprime ensuite les lignes expirées).
 *
 * Ordre de décision (permissions.md, §1) :
 *   1. règle utilisateur (user-grant / user-revoke)
 *   2. règles de rôles : un rôle autorisé suffit ; sinon un rôle révoqué bloque
 *   3. commande publique sur le serveur
 *   4. défaut de la commande : 'everyone' ou, pour les commandes sensibles, Administrateurs uniquement
 */
class PermissionService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.cache = new Map();
    this.webGrantCache = new Map();
  }

  /** Règles en vigueur : Map(commande → Map(cible → { allowed, expiresAt })) pour les utilisateurs et les rôles. */
  async rules(guildId) {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() < cached.staleAt) return cached;
    const now = new Date();
    const [users, roles, publics] = await Promise.all([
      this.db.query(`SELECT user_id, command_name, has_permission, expires_at FROM permissions_users WHERE guild_id = ? AND ${NOT_EXPIRED}`, [guildId, now]),
      this.db.query(`SELECT role_id, command_name, has_permission, expires_at FROM permissions_roles WHERE guild_id = ? AND ${NOT_EXPIRED}`, [guildId, now]),
      this.db.query('SELECT command_name, is_public FROM permissions_public WHERE guild_id = ?', [guildId]),
    ]);
    const rules = { users: new Map(), roles: new Map(), public: new Set(), staleAt: Math.min(nextExpiry(users), nextExpiry(roles)) };
    const entry = (row) => ({ allowed: Boolean(Number(row.has_permission)), expiresAt: row.expires_at ?? null });
    for (const row of users) mapOf(rules.users, row.command_name).set(String(row.user_id), entry(row));
    for (const row of roles) mapOf(rules.roles, row.command_name).set(String(row.role_id), entry(row));
    for (const row of publics) if (Number(row.is_public)) rules.public.add(row.command_name);
    this.cache.set(guildId, rules);
    return rules;
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
  }

  /**
   * Décision détaillée (utilisée aussi par /permission check) : la règle qui a tranché, le rôle concerné
   * et son échéance éventuelle.
   * @param {{ guildId, userId, roleIds: string[], isAdmin: boolean, command: string, defaultAccess: 'admin'|'everyone' }} input
   * @returns {Promise<{ allowed: boolean, source: 'user'|'role'|'public'|'default', roleId?: string, expiresAt?: Date|null }>}
   */
  async decide({ guildId, userId, roleIds, isAdmin, command, module = null, defaultAccess }) {
    const rules = await this.rules(guildId);
    // Joker « module.* » : une règle sur toutes les commandes d'un module (présentes et futures). Une règle
    // individuelle précise sur la commande l'emporte sur le joker de son module.
    const wildcard = module ? wildcardOf(module) : null;

    const userRule = rules.users.get(command)?.get(userId) ?? (wildcard ? rules.users.get(wildcard)?.get(userId) : undefined);
    if (userRule) return { allowed: userRule.allowed, source: 'user', expiresAt: userRule.expiresAt };

    const matches = [];
    for (const key of [command, wildcard]) {
      const roleRules = key ? rules.roles.get(key) : null;
      if (!roleRules) continue;
      for (const id of roleIds) if (roleRules.has(id)) matches.push([id, roleRules.get(id)]);
    }
    if (matches.length) {
      const granted = matches.find(([, rule]) => rule.allowed);
      if (granted) return { allowed: true, source: 'role', roleId: granted[0], expiresAt: granted[1].expiresAt };
      return { allowed: false, source: 'role', roleId: matches[0][0], expiresAt: matches[0][1].expiresAt };
    }

    if (rules.public.has(command)) return { allowed: true, source: 'public' };

    return { allowed: defaultAccess === 'everyone' || isAdmin, source: 'default' };
  }

  // ── Modifications ─────────────────────────────────────────────────────────

  /**
   * Crée ou met à jour une règle ; renvoie l'ancienne valeur (true, false ou null). `expiresAt` : accord
   * temporaire. Une autorisation permanente déjà en place n'est jamais remplacée par une temporaire (elle
   * disparaîtrait à l'échéance) : elle est laissée telle quelle.
   */
  async setRule(kind, guildId, targetId, command, allowed, updatedBy, expiresAt = null) {
    const table = kind === 'role' ? 'permissions_roles' : 'permissions_users';
    const column = kind === 'role' ? 'role_id' : 'user_id';
    const previous = await this.db.one(
      `SELECT has_permission, expires_at FROM ${table} WHERE guild_id = ? AND ${column} = ? AND command_name = ? AND ${NOT_EXPIRED}`,
      [guildId, targetId, command, new Date()],
    );
    const previousAllowed = previous ? Boolean(Number(previous.has_permission)) : null;
    if (expiresAt && previousAllowed === allowed && !previous.expires_at) return previousAllowed;
    await this.db.query(
      `INSERT INTO ${table} (guild_id, ${column}, command_name, has_permission, updated_by, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE has_permission = VALUES(has_permission), updated_by = VALUES(updated_by),
         updated_at = VALUES(updated_at), expires_at = VALUES(expires_at)`,
      [guildId, targetId, command, allowed ? 1 : 0, updatedBy, new Date(), expiresAt],
    );
    this.invalidate(guildId);
    return previousAllowed;
  }

  /** Supprime une règle (retour au comportement par défaut pour cette cible) ; renvoie true si elle existait. */
  async removeRule(kind, guildId, targetId, command) {
    const table = kind === 'role' ? 'permissions_roles' : 'permissions_users';
    const column = kind === 'role' ? 'role_id' : 'user_id';
    const result = await this.db.query(`DELETE FROM ${table} WHERE guild_id = ? AND ${column} = ? AND command_name = ?`, [guildId, targetId, command]);
    this.invalidate(guildId);
    return Number(result.affectedRows ?? 0) > 0;
  }

  /** Fixe explicitement le statut public d'une commande (le panel web ne bascule pas à l'aveugle). */
  async setPublic(guildId, command, isPublic, updatedBy) {
    await this.db.query(
      `INSERT INTO permissions_public (guild_id, command_name, is_public, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_public = VALUES(is_public), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [guildId, command, isPublic ? 1 : 0, updatedBy, new Date()],
    );
    this.invalidate(guildId);
  }

  /** Bascule le statut public d'une commande ; renvoie le nouvel état. */
  async togglePublic(guildId, command, updatedBy) {
    await this.db.query(
      `INSERT INTO permissions_public (guild_id, command_name, is_public, updated_by, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE is_public = 1 - is_public, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [guildId, command, updatedBy, new Date()],
    );
    this.invalidate(guildId);
    const row = await this.db.one('SELECT is_public FROM permissions_public WHERE guild_id = ? AND command_name = ?', [
      guildId,
      command,
    ]);
    return Boolean(Number(row?.is_public));
  }

  /** Supprime toutes les règles du serveur (commandes ET accès au panel web) ; renvoie le nombre de lignes effacées par table. */
  async purge(guildId) {
    const counts = await this.db.transaction(async (connection) => {
      const result = {};
      for (const table of ['permissions_users', 'permissions_roles', 'permissions_public', 'web_permission_grants']) {
        const [res] = await connection.query(`DELETE FROM ${table} WHERE guild_id = ?`, [guildId]);
        result[table] = res.affectedRows;
      }
      return result;
    });
    this.invalidate(guildId);
    this.invalidateWebGrants(guildId);
    return counts;
  }

  /** Supprime les accords temporaires échus (toutes tables, tous serveurs) ; renvoie les serveurs concernés. */
  async sweepExpired() {
    const now = new Date();
    const guildIds = new Set();
    for (const table of ['permissions_users', 'permissions_roles', 'web_permission_grants']) {
      const rows = await this.db.query(`SELECT DISTINCT guild_id FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now]);
      if (!rows.length) continue;
      await this.db.query(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now]);
      for (const row of rows) guildIds.add(String(row.guild_id));
    }
    for (const guildId of guildIds) {
      this.invalidate(guildId);
      this.invalidateWebGrants(guildId);
    }
    return [...guildIds];
  }

  // ── Consultation ──────────────────────────────────────────────────────────

  /**
   * Règles regroupées par cible : Map(targetId → { allowed: [], denied: [], expiring: { commande: date } }).
   * `expiring` ne liste que les règles temporaires.
   */
  async listByTarget(guildId, kind) {
    const rules = await this.rules(guildId);
    const source = kind === 'role' ? rules.roles : rules.users;
    const targets = new Map();
    for (const [command, entries] of source) {
      for (const [targetId, rule] of entries) {
        if (!targets.has(targetId)) targets.set(targetId, { allowed: [], denied: [], expiring: {} });
        const target = targets.get(targetId);
        target[rule.allowed ? 'allowed' : 'denied'].push(command);
        if (rule.expiresAt) target.expiring[command] = rule.expiresAt;
      }
    }
    for (const entry of targets.values()) {
      entry.allowed.sort();
      entry.denied.sort();
    }
    return targets;
  }

  async publicCommands(guildId) {
    const rules = await this.rules(guildId);
    return [...rules.public].sort();
  }

  /** Règles (en vigueur) d'un rôle, lues en base : commandes et accès au panel web, avec leurs échéances. */
  async roleSnapshot(guildId, roleId) {
    const now = new Date();
    const [rules, web] = await Promise.all([
      this.db.query(`SELECT command_name, has_permission, expires_at FROM permissions_roles WHERE guild_id = ? AND role_id = ? AND ${NOT_EXPIRED}`, [guildId, roleId, now]),
      this.db.query(`SELECT category, right_key, expires_at FROM web_permission_grants WHERE guild_id = ? AND role_id = ? AND ${NOT_EXPIRED}`, [guildId, roleId, now]),
    ]);
    return {
      rules: rules.map((row) => ({ command: row.command_name, allowed: Boolean(Number(row.has_permission)), expiresAt: row.expires_at ?? null })),
      web: web.map((row) => ({ category: row.category, right: row.right_key, expiresAt: row.expires_at ?? null })),
    };
  }

  /** Supprime toutes les règles (commandes et panel web) d'un rôle ; utilisé avant une copie « en remplaçant ». */
  async clearRole(guildId, roleId) {
    await this.db.query('DELETE FROM permissions_roles WHERE guild_id = ? AND role_id = ?', [guildId, roleId]);
    await this.db.query('DELETE FROM web_permission_grants WHERE guild_id = ? AND role_id = ?', [guildId, roleId]);
    this.invalidate(guildId);
    this.invalidateWebGrants(guildId);
  }

  /**
   * Applique un ensemble de règles à un rôle (modèle ou copie d'un autre rôle). `replace` : les règles
   * existantes du rôle sont d'abord effacées ; sinon elles sont complétées/écrasées commande par commande.
   * `isValid(command)` écarte les commandes qui n'existent plus. Renvoie { rules, web } (nombre appliqué).
   */
  async applyToRole(guildId, roleId, { rules, web }, by, { replace = false, keepExpiry = false, isValid = () => true, isValidWeb = () => true } = {}) {
    if (replace) await this.clearRole(guildId, roleId);
    let ruleCount = 0;
    let webCount = 0;
    for (const rule of rules) {
      if (!isValid(rule.command)) continue;
      await this.setRule('role', guildId, roleId, rule.command, rule.allowed, by, keepExpiry ? rule.expiresAt ?? null : null);
      ruleCount += 1;
    }
    for (const grant of web) {
      if (!isValidWeb(grant.category, grant.right)) continue;
      await this.grantWeb(guildId, roleId, grant.category, grant.right, by, keepExpiry ? grant.expiresAt ?? null : null);
      webCount += 1;
    }
    return { rules: ruleCount, web: webCount };
  }

  // ── Modèles de permissions ───────────────────────────────────────────────

  mapTemplate(row) {
    if (!row) return null;
    return { ...row, rules: parseJson(row.rules, []), web: parseJson(row.web, []) };
  }

  async listTemplates(guildId) {
    const rows = await this.db.query('SELECT * FROM permissions_templates WHERE guild_id = ? ORDER BY name ASC', [guildId]);
    return rows.map((row) => this.mapTemplate(row));
  }

  async templateByName(guildId, name) {
    return this.mapTemplate(await this.db.one('SELECT * FROM permissions_templates WHERE guild_id = ? AND name = ?', [guildId, name]));
  }

  async getTemplate(guildId, id) {
    return this.mapTemplate(await this.db.one('SELECT * FROM permissions_templates WHERE guild_id = ? AND id = ?', [guildId, id]));
  }

  /** Crée ou remplace (même nom) un modèle ; `rules`/`web` sans échéance (un modèle est toujours permanent). */
  async saveTemplate(guildId, { name, description = null, rules, web }, by) {
    const now = new Date();
    const cleanRules = rules.map((r) => ({ command: r.command, allowed: Boolean(r.allowed) }));
    const cleanWeb = web.map((g) => ({ category: g.category, right: g.right ?? '' }));
    await this.db.query(
      `INSERT INTO permissions_templates (guild_id, name, description, rules, web, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description), rules = VALUES(rules), web = VALUES(web), updated_at = VALUES(updated_at)`,
      [guildId, name, description, JSON.stringify(cleanRules), JSON.stringify(cleanWeb), by, now, now],
    );
    return this.templateByName(guildId, name);
  }

  async deleteTemplate(guildId, id) {
    const result = await this.db.query('DELETE FROM permissions_templates WHERE guild_id = ? AND id = ?', [guildId, id]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  // ── Accès au panel web (/permission grant-panel) ─────────────────────────

  /** Lignes de `web_permission_grants` en vigueur pour une catégorie, mises en cache (invalidées à l'écriture et à l'échéance). */
  async webGrants(guildId, category) {
    const key = `${guildId}:${category}`;
    const cached = this.webGrantCache.get(key);
    if (cached && Date.now() < cached.staleAt) return cached.rows;
    const rows = await this.db.query(`SELECT role_id, right_key, expires_at FROM web_permission_grants WHERE guild_id = ? AND category = ? AND ${NOT_EXPIRED}`, [
      guildId,
      category,
      new Date(),
    ]);
    this.webGrantCache.set(key, { rows, staleAt: nextExpiry(rows) });
    return rows;
  }

  invalidateWebGrants(guildId) {
    for (const key of this.webGrantCache.keys()) if (key.startsWith(`${guildId}:`)) this.webGrantCache.delete(key);
  }

  /** `expiresAt` : accès temporaire ; un accès permanent déjà en place n'est pas remplacé par un temporaire. */
  async grantWeb(guildId, roleId, category, rightKey, grantedBy, expiresAt = null) {
    if (expiresAt) {
      const existing = await this.db.one(
        'SELECT expires_at FROM web_permission_grants WHERE guild_id = ? AND role_id = ? AND category = ? AND right_key = ?',
        [guildId, roleId, category, rightKey],
      );
      if (existing && !existing.expires_at) return;
    }
    await this.db.query(
      `INSERT INTO web_permission_grants (guild_id, role_id, category, right_key, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by), granted_at = VALUES(granted_at), expires_at = VALUES(expires_at)`,
      [guildId, roleId, category, rightKey, grantedBy, new Date(), expiresAt],
    );
    this.invalidateWebGrants(guildId);
  }

  async revokeWeb(guildId, roleId, category, rightKey) {
    await this.db.query('DELETE FROM web_permission_grants WHERE guild_id = ? AND role_id = ? AND category = ? AND right_key = ?', [
      guildId,
      roleId,
      category,
      rightKey,
    ]);
    this.invalidateWebGrants(guildId);
  }

  async allWebGrants(guildId) {
    return this.db.query(
      `SELECT role_id, category, right_key, expires_at FROM web_permission_grants WHERE guild_id = ? AND ${NOT_EXPIRED} ORDER BY category, role_id`,
      [guildId, new Date()],
    );
  }
}

module.exports = { PermissionService, wildcardOf, wildcardModule };
