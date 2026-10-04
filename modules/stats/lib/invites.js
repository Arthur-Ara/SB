'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { KeyedMutex } = require('../../../src/core/keyedMutex');

/**
 * Suivi des invitations (désactivé par défaut, par serveur) : Discord n'indique pas quelle invitation a servi
 * à une arrivée. On garde donc le nombre d'utilisations de chaque invitation (et de l'URL personnalisée) en
 * mémoire ; à chaque arrivée, on relit les invitations et celle dont le compteur a augmenté est la bonne.
 * Nécessite la permission « Gérer le serveur ». Deux arrivées simultanées sont traitées l'une après l'autre.
 */
class InviteTracker {
  constructor({ db, client, config, logger, enabledFor }) {
    this.db = db;
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.enabledFor = enabledFor;
    this.uses = new Map(); // guildId → { invites: Map(code → { uses, inviterId }), vanity: number|null }
    this.mutex = new KeyedMutex();
  }

  canRead(guild) {
    return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));
  }

  async active(guild) {
    return this.enabledFor(guild.id) && (await this.config.get(guild.id)).inviteTracking;
  }

  /** Lit toutes les invitations du serveur, met le cache mémoire et la table `stats_invites` à jour. */
  async snapshot(guild) {
    if (!this.canRead(guild)) return null;
    const invites = await guild.invites.fetch({ cache: false });
    const vanity = guild.vanityURLCode ? await guild.fetchVanityData().catch(() => null) : null;
    const state = { invites: new Map(), vanity: vanity ? vanity.uses : null };
    const rows = [];
    for (const invite of invites.values()) {
      state.invites.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId ?? null, maxUses: invite.maxUses || null });
      rows.push([
        guild.id,
        invite.code,
        invite.inviterId ?? null,
        invite.channelId ?? null,
        invite.uses ?? 0,
        invite.maxUses || null,
        invite.createdAt ?? null,
        invite.expiresAt ?? null,
      ]);
    }
    if (rows.length) {
      await this.db.query(
        `INSERT INTO stats_invites (guild_id, code, inviter_id, channel_id, uses, max_uses, created_at, expires_at) VALUES ?
         ON DUPLICATE KEY UPDATE uses = VALUES(uses), inviter_id = VALUES(inviter_id), deleted_at = NULL`,
        [rows],
      );
    }
    this.uses.set(guild.id, state);
    return state;
  }

  /** Démarrage (ou activation depuis le panel) : état de référence pour chaque serveur suivi. */
  async warmup(guilds) {
    for (const guild of guilds) {
      if (!(await this.active(guild))) continue;
      await this.snapshot(guild).catch((err) => this.logger.warn(`Invitations de « ${guild.name} » illisibles`, err.message));
    }
  }

  async onInviteCreate(invite) {
    if (!invite.guild || !(await this.active(invite.guild))) return;
    const state = this.uses.get(invite.guild.id);
    state?.invites.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId ?? null, maxUses: invite.maxUses || null });
    await this.db.query(
      `INSERT INTO stats_invites (guild_id, code, inviter_id, channel_id, uses, max_uses, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE uses = VALUES(uses), deleted_at = NULL`,
      [invite.guild.id, invite.code, invite.inviterId ?? null, invite.channelId ?? null, invite.uses ?? 0, invite.maxUses || null, invite.createdAt ?? new Date(), invite.expiresAt ?? null],
    );
  }

  async onInviteDelete(invite) {
    if (!invite.guild) return;
    await this.db.query('UPDATE stats_invites SET deleted_at = ? WHERE guild_id = ? AND code = ?', [new Date(), invite.guild.id, invite.code]);
    // Gardé en mémoire : une invitation à usage unique est supprimée au moment même où elle sert.
  }

  /** Arrivée d'un membre : invitation utilisée (compteur qui a augmenté), URL personnalisée, ou inconnue. */
  async onMemberAdd(member) {
    const guild = member.guild;
    if (!(await this.active(guild))) return;
    await this.mutex.run(guild.id, async () => {
      const before = this.uses.get(guild.id);
      let after;
      try {
        after = await this.snapshot(guild);
      } catch (err) {
        this.logger.warn(`Invitations de « ${guild.name} » illisibles`, err.message);
      }
      let source = 'unknown';
      let code = null;
      let inviterId = null;
      if (before && after) {
        const used = [...after.invites.entries()].filter(([c, now]) => now.uses > (before.invites.get(c)?.uses ?? 0));
        // Invitation à usage unique : supprimée par Discord dès son utilisation, elle disparaît de la liste.
        const vanished = [...before.invites.entries()].filter(([c, prev]) => !after.invites.has(c) && prev.maxUses && prev.uses + 1 >= prev.maxUses);
        if (used.length === 1) [[code, { inviterId }]] = used;
        else if (!used.length && vanished.length === 1) [[code, { inviterId }]] = vanished;
        if (code) source = 'invite';
        else if (after.vanity !== null && before.vanity !== null && after.vanity > before.vanity) source = 'vanity';
      }
      if (source === 'invite' && !inviterId) {
        const row = await this.db.one('SELECT inviter_id FROM stats_invites WHERE guild_id = ? AND code = ?', [guild.id, code]);
        inviterId = row?.inviter_id ? String(row.inviter_id) : null;
      }
      await this.db.query(
        'INSERT INTO stats_invite_joins (guild_id, user_id, code, inviter_id, source, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
        [guild.id, member.id, code, inviterId, source, member.joinedAt ?? new Date()],
      );
    });
  }

  async onMemberRemove(member) {
    if (!(await this.active(member.guild))) return;
    await this.db.query(
      `UPDATE stats_invite_joins SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1`,
      [new Date(), member.guild.id, member.id],
    );
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  /** Classement des parrains sur la période : arrivées, départs depuis, arrivées restées. */
  async leaderboard(guildId, from, to, limit = 10) {
    const rows = await this.db.query(
      `SELECT inviter_id, COUNT(*) AS joins, SUM(left_at IS NOT NULL) AS lefts
         FROM stats_invite_joins
        WHERE guild_id = ? AND source = 'invite' AND inviter_id IS NOT NULL AND joined_at >= ? AND joined_at < ?
        GROUP BY inviter_id ORDER BY joins DESC LIMIT ?`,
      [guildId, from, to, limit],
    );
    return rows.map((row) => ({ userId: String(row.inviter_id), joins: Number(row.joins), left: Number(row.lefts), stayed: Number(row.joins) - Number(row.lefts) }));
  }

  /** Répartition des arrivées de la période par origine. */
  async sources(guildId, from, to) {
    const rows = await this.db.query(
      'SELECT source, COUNT(*) AS n FROM stats_invite_joins WHERE guild_id = ? AND joined_at >= ? AND joined_at < ? GROUP BY source',
      [guildId, from, to],
    );
    const result = { invite: 0, vanity: 0, unknown: 0 };
    for (const row of rows) result[row.source] = Number(row.n);
    return result;
  }

  /** Invitations les plus utilisées de la période. */
  async topCodes(guildId, from, to, limit = 10) {
    const rows = await this.db.query(
      `SELECT j.code, j.inviter_id, COUNT(*) AS joins, i.deleted_at, i.channel_id
         FROM stats_invite_joins j LEFT JOIN stats_invites i ON i.guild_id = j.guild_id AND i.code = j.code
        WHERE j.guild_id = ? AND j.source = 'invite' AND j.joined_at >= ? AND j.joined_at < ?
        GROUP BY j.code, j.inviter_id, i.deleted_at, i.channel_id ORDER BY joins DESC LIMIT ?`,
      [guildId, from, to, limit],
    );
    return rows.map((row) => ({
      code: row.code,
      inviterId: row.inviter_id ? String(row.inviter_id) : null,
      joins: Number(row.joins),
      deleted: Boolean(row.deleted_at),
      channelId: row.channel_id ? String(row.channel_id) : null,
    }));
  }
}

module.exports = { InviteTracker };
