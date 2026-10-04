'use strict';

/**
 * Admins globaux du bot (/admin). Un admin global a les droits d'un propriétaire du bot partout : tous les serveurs,
 * tous les modules (gestion via /modules, contrôles d'accès qui consultent `config.owners`) et le panel web. Seuls
 * les propriétaires déclarés dans le .env (`config.envOwners`) peuvent en ajouter ou en retirer.
 *
 * `config.owners` et `config.web.authorizedUsers` sont des Set partagés par tout le code : ils sont tenus à jour en
 * place (le .env, plus la base), ce qui évite d'avoir à modifier chaque contrôle d'accès existant.
 */
class BotAdmins {
  constructor({ db, config, logger }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.ids = new Set();
  }

  async load() {
    const rows = await this.db.query('SELECT user_id FROM bot_admins');
    this.ids = new Set(rows.map((row) => String(row.user_id)));
    this.apply();
  }

  /** Recalcule les Set partagés : .env ∪ admins globaux. */
  apply() {
    const { owners, envOwners, web } = this.config;
    owners.clear();
    for (const id of [...envOwners, ...this.ids]) owners.add(id);
    web.authorizedUsers.clear();
    for (const id of [...web.envAuthorizedUsers, ...this.ids]) web.authorizedUsers.add(id);
  }

  isEnvOwner(userId) {
    return this.config.envOwners.has(String(userId));
  }

  has(userId) {
    return this.ids.has(String(userId));
  }

  async list() {
    return this.db.query('SELECT user_id, added_by, added_at FROM bot_admins ORDER BY added_at ASC');
  }

  async add(userId, addedBy) {
    await this.db.query('INSERT INTO bot_admins (user_id, added_by, added_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id', [userId, addedBy, new Date()]);
    this.ids.add(String(userId));
    this.apply();
  }

  async remove(userId) {
    await this.db.query('DELETE FROM bot_admins WHERE user_id = ?', [userId]);
    this.ids.delete(String(userId));
    this.apply();
  }
}

module.exports = { BotAdmins };
