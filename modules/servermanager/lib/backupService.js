'use strict';

const ui = require('../../../src/bot/ui');
const { capture, planRestore, executeRestore } = require('./backup');

const CHECK_MS = 30 * 60_000;

/**
 * Sauvegardes du Server Manager : création (manuelle ou planifiée), aperçu et exécution d'une restauration,
 * une seule restauration à la fois par serveur (et jamais pendant un rollback).
 */
class BackupService {
  constructor({ client, store, journal, engine, logger, enabledFor }) {
    this.client = client;
    this.store = store;
    this.journal = journal;
    this.engine = engine;
    this.logger = logger;
    this.enabledFor = enabledFor;
    this.restoring = new Set();
    this.timer = null;
  }

  /** Salons de tickets / modmail : jamais sauvegardés ni recréés par une restauration (comme pour les rollbacks). */
  async excluded(guildId) {
    return new Set(await this.engine.excludedChannelIds(guildId));
  }

  async create(guild, { name = null, origin = 'manual', createdBy = null } = {}) {
    const data = capture(guild, await this.excluded(guild.id));
    const label = name || `${origin === 'auto' ? 'Automatique' : 'Sauvegarde'} du ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`;
    const id = await this.store.createBackup({ guildId: guild.id, name: label, origin, data, createdBy });
    if (origin === 'auto') await this.store.updateBackupSettings(guild.id, { last_backup_at: new Date() });
    await this.log(guild.id, `💾 Sauvegarde **#${id}** créée (${data.roles.length} rôles, ${data.channels.length} salons)${createdBy ? ` par <@${createdBy}>` : ' automatiquement'}.`);
    return { id, roles: data.roles.length, channels: data.channels.length };
  }

  async preview(guild, backupId, invoker) {
    const backup = await this.store.getBackup(guild.id, backupId);
    if (!backup) return { error: 'Sauvegarde introuvable.' };
    const plan = await planRestore(guild, backup.data, invoker, await this.excluded(guild.id));
    if (plan.error) return { error: plan.error };
    return { backup, plan };
  }

  /** Restauration confirmée (empreinte de l'aperçu) ; `onProgress({ index, total, label })`. */
  async restore(guild, backupId, invoker, { expectedHash, onProgress, abort } = {}) {
    if (this.restoring.has(guild.id)) return { error: 'Une restauration est déjà en cours sur ce serveur.' };
    if (this.engine.running.has(guild.id)) return { error: 'Un rollback est en cours sur ce serveur : réessaie quand il sera terminé.' };
    const backup = await this.store.getBackup(guild.id, backupId);
    if (!backup) return { error: 'Sauvegarde introuvable.' };
    this.restoring.add(guild.id);
    try {
      await this.log(guild.id, `♻️ Restauration de la sauvegarde **#${backupId}** lancée par <@${invoker.id}>.`);
      const result = await executeRestore({ guild, data: backup.data, invoker, expectedHash, backupId, journal: this.journal, onProgress, abort, excluded: await this.excluded(guild.id) });
      if (!result.error) {
        await this.store.markRestored(backupId, invoker.id);
        await this.log(guild.id, `♻️ Restauration **#${backupId}** terminée : ✅ ${result.done} · ❌ ${result.failed}${result.cancelled ? ` · ⏹️ ${result.cancelled}` : ''}.`);
      }
      return result;
    } finally {
      this.restoring.delete(guild.id);
    }
  }

  async log(guildId, text) {
    try {
      const { logChannelId } = await this.store.settings(guildId);
      if (!logChannelId) return;
      const channel = this.client.channels.cache.get(String(logChannelId)) ?? (await this.client.channels.fetch(String(logChannelId)));
      if (channel?.isTextBased()) await channel.send(ui.payload(ui.card({ description: text, timestamp: true })));
    } catch (err) {
      this.logger.warn(`Journal des sauvegardes indisponible (${guildId})`, err.message);
    }
  }

  // ── Sauvegardes automatiques ─────────────────────────────────────────────

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const guildId of await this.store.backupGuildIds()) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild || !this.enabledFor(guildId)) continue;
        const settings = await this.store.settings(guildId);
        if (settings.lastBackupAt && Date.now() - settings.lastBackupAt < settings.backupIntervalHours * 3_600_000) continue;
        try {
          await this.create(guild, { origin: 'auto' });
          await this.store.pruneAutoBackups(guildId, settings.backupKeep);
        } catch (err) {
          this.logger.error(`Sauvegarde automatique de « ${guild.name} » impossible`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  start() {
    if (this.timer) return;
    const run = () => this.tick().catch((err) => this.logger.error('Planification des sauvegardes impossible', err));
    run();
    this.timer = setInterval(run, CHECK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { BackupService };
