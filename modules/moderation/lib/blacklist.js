'use strict';

/** Préfixe de la raison de tous les bannissements posés par la blacklist (sert à les reconnaître à la levée). */
const BLACKLIST_PREFIX = 'Blacklist';

function blacklistReason(reason) {
  return `${BLACKLIST_PREFIX}${reason ? ` : ${reason}` : ''}`.slice(0, 512);
}

/** Ce bannissement a-t-il été posé par la blacklist ? (un ban posé pour une autre raison n'est jamais levé par /unblacklist) */
function isBlacklistBan(ban) {
  return String(ban?.reason ?? '').startsWith(BLACKLIST_PREFIX);
}

/** Serveurs concernés par la blacklist : bot présent et module Modération activé. */
function targetGuilds(ctx, excludeGuildId) {
  return [...ctx.client.guilds.cache.values()].filter((guild) => guild.id !== excludeGuildId && ctx.modules.isEnabledFor('moderation', guild.id));
}

/**
 * Bannit un utilisateur sur tous les serveurs où le bot est présent et où Modération est activée
 * (hors `excludeGuildId`, déjà traité séparément par l'appelant), en parallèle. Une sanction est
 * enregistrée et journalisée sur CHAQUE serveur concerné, pour rester visible dans /history partout
 * où elle s'applique. Renvoie le nombre de serveurs effectivement bannis.
 */
async function banEverywhere(ctx, userId, reason, { excludeGuildId, executorId } = {}) {
  const { moderation, logs } = ctx.services;
  const results = await Promise.all(
    targetGuilds(ctx, excludeGuildId).map(async (guild) => {
      if (await guild.bans.fetch({ user: userId, force: true }).catch(() => null)) return false;
      try {
        await guild.members.ban(userId, { reason: blacklistReason(reason) });
      } catch (err) {
        ctx.logger.warn(`Blacklist : bannissement sur « ${guild.name} » impossible`, err.message);
        return false;
      }
      const by = executorId ?? ctx.client.user.id;
      const id = await moderation.record({ guildId: guild.id, action: 'blacklist', targetId: userId, executorId: by, reason });
      await logs.action({ guildId: guild.id, action: 'blacklist', targetId: userId, executorId: by, reason: reason ?? 'Blacklist (appliquée depuis un autre serveur)', id });
      return true;
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * Lève, sur tous les serveurs (Modération activée, hors `excludeGuildId`), les bannissements **posés par la
 * blacklist** — un ban posé pour une autre raison est laissé en place. Renvoie le nombre de serveurs débannis.
 */
async function unbanEverywhere(ctx, userId, reason, { excludeGuildId, executorId } = {}) {
  const { moderation, logs } = ctx.services;
  const results = await Promise.all(
    targetGuilds(ctx, excludeGuildId).map(async (guild) => {
      const ban = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
      if (!ban || !isBlacklistBan(ban)) return false;
      try {
        await guild.members.unban(userId, `Fin de blacklist${reason ? ` : ${reason}` : ''}`.slice(0, 512));
      } catch (err) {
        ctx.logger.warn(`Fin de blacklist : débannissement sur « ${guild.name} » impossible`, err.message);
        return false;
      }
      const by = executorId ?? ctx.client.user.id;
      const id = await moderation.record({ guildId: guild.id, action: 'unblacklist', targetId: userId, executorId: by, reason });
      await logs.action({ guildId: guild.id, action: 'unblacklist', targetId: userId, executorId: by, reason: reason ?? 'Fin de blacklist (levée depuis un autre serveur)', id });
      return true;
    }),
  );
  return results.filter(Boolean).length;
}

module.exports = { BLACKLIST_PREFIX, blacklistReason, isBlacklistBan, banEverywhere, unbanEverywhere };
