'use strict';

const { detectNitro } = require('./discordUtils');

/**
 * Instantanés périodiques de l'état de chaque serveur : nombre total de membres,
 * boosts, boosters et membres Nitro (estimation). Sert à tracer la croissance.
 */
class SnapshotService {
  constructor({ client, store, members, logger, settings, enabledFor = () => true }) {
    this.client = client;
    this.store = store;
    this.members = members;
    this.logger = logger;
    this.enabledFor = enabledFor;
    this.intervalMs = settings.snapshotIntervalMinutes * 60_000;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.takeAll();
    this.timer = setInterval(() => this.takeAll(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async takeAll() {
    for (const guild of this.client.guilds.cache.values()) {
      if (!this.enabledFor(guild.id)) continue;
      try {
        await this.members.syncStructure(guild);
        await this.take(guild);
      } catch (err) {
        this.logger.warn(`Instantané impossible pour ${guild.name}`, err.message);
      }
    }
  }

  async take(guild) {
    const humans = [...guild.members.cache.values()].filter((member) => !member.user.bot);
    await this.store.insertSnapshots([
      [
        guild.id,
        new Date(),
        guild.memberCount,
        guild.premiumSubscriptionCount ?? 0,
        humans.filter((member) => member.premiumSince).length,
        humans.filter(detectNitro).length,
        'live',
      ],
    ]);
  }
}

module.exports = { SnapshotService };
