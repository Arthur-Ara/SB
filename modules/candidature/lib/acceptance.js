'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

/** Durée de validité de l'invitation : 24 h par défaut, 7 jours au plus (limite Discord). */
const DEFAULT_INVITE_HOURS = 24;
const MAX_INVITE_HOURS = 168;

function inviteHours(category) {
  const hours = Number(category?.accept_invite_hours);
  return Number.isInteger(hours) && hours > 0 ? Math.min(hours, MAX_INVITE_HOURS) : DEFAULT_INVITE_HOURS;
}

/** Salon où le bot peut créer une invitation : règlement, salon système, puis le premier salon textuel permis. */
function inviteChannel(guild) {
  const me = guild.members.me;
  const allowed = (channel) => channel && me && channel.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite);
  const candidates = [guild.rulesChannel, guild.systemChannel, ...[...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.position - b.position)];
  return candidates.find(allowed) ?? null;
}

/**
 * Invitation vers le serveur configuré, à **une seule utilisation** et unique (jamais réutilisée par Discord), envoyée
 * uniquement au candidat accepté. Discord ne permet pas de réserver une invitation à un compte : l'usage unique, la
 * durée courte et l'envoi en message privé en limitent l'usage à la personne qui la reçoit.
 * @returns {Promise<{ url?: string, expiresAt?: Date, guildName?: string, error?: string }>}
 */
async function createSingleUseInvite(ctx, category, candidature) {
  if (!category?.accept_invite_guild_id) return {};
  const target = ctx.client.guilds.cache.get(String(category.accept_invite_guild_id));
  if (!target) return { error: 'serveur d’invitation introuvable (le bot n’y est plus)' };
  const channel = inviteChannel(target);
  if (!channel) return { error: `aucun salon de « ${target.name} » où le bot peut créer une invitation` };
  const hours = inviteHours(category);
  const invite = await channel.createInvite({ maxUses: 1, maxAge: hours * 3600, unique: true, reason: `Candidature #${candidature.id} acceptée (${candidature.applicant_id})` });
  return { url: invite.url, expiresAt: new Date(Date.now() + hours * 3600 * 1000), guildName: target.name };
}

/** Rôles d'acceptation (plusieurs possibles) donnés au candidat ; renvoie les rôles qui n'ont pas pu être donnés. */
async function giveAcceptRoles(ctx, guild, category, candidature) {
  const ids = (category?.accept_role_ids ?? []).filter((id) => guild.roles.cache.has(id));
  if (!ids.length) return [];
  const member = guild.members.cache.get(String(candidature.applicant_id)) ?? (await guild.members.fetch(String(candidature.applicant_id)).catch(() => null));
  if (!member) return ids;
  try {
    await member.roles.add(ids, `Candidature #${candidature.id} acceptée`);
    return [];
  } catch (err) {
    ctx.logger.warn(`Rôles d’acceptation non donnés (candidature #${candidature.id})`, err.message);
    return ids;
  }
}

module.exports = { DEFAULT_INVITE_HOURS, MAX_INVITE_HOURS, inviteHours, inviteChannel, createSingleUseInvite, giveAcceptRoles };
