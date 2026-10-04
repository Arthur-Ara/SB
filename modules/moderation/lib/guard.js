'use strict';

/**
 * Vérifications de sécurité communes à toutes les sanctions visant un membre : on ne peut pas
 * sanctionner le propriétaire du serveur, le bot lui-même, ni quelqu'un dont le rôle le plus haut
 * est égal ou supérieur au sien (sauf le propriétaire du serveur, qui n'est jamais bloqué).
 * En cas d'échec réel de l'appel Discord (permissions du bot insuffisantes malgré ce contrôle),
 * l'erreur est de toute façon rattrapée et affichée proprement par chaque commande.
 *
 * @param {import('discord.js').GuildMember} actor   celui qui exécute la commande
 * @param {import('discord.js').GuildMember} target  celui qui la subit
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canModerate(actor, target) {
  const guild = actor.guild;
  if (target.id === actor.client.user.id) return { allowed: false, reason: 'Impossible de sanctionner le bot lui-même.' };
  if (target.id === actor.id) return { allowed: false, reason: 'Impossible de se sanctionner soi-même.' };
  if (target.id === guild.ownerId) return { allowed: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  if (actor.id !== guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
    return { allowed: false, reason: `<@${target.id}> a un rôle égal ou supérieur au tien : impossible de le sanctionner.` };
  }
  return { allowed: true };
}

/** Vérifications de base, utilisables même quand la cible n'est plus (ou pas encore) membre du serveur. */
function basicChecks(interaction, targetUser) {
  if (targetUser.id === interaction.client.user.id) return { allowed: false, reason: 'Impossible de sanctionner le bot lui-même.' };
  if (targetUser.id === interaction.user.id) return { allowed: false, reason: 'Impossible de se sanctionner soi-même.' };
  if (targetUser.id === interaction.guild.ownerId) return { allowed: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  return { allowed: true };
}

/**
 * Résout l'option « user » d'une commande et applique tous les contrôles de sécurité d'un coup.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ requireMember?: boolean }} [options] requireMember=false pour /ban (peut viser un non-membre)
 * @returns {Promise<{ user?, member?, error?: string }>}
 */
async function resolveTarget(interaction, { requireMember = true } = {}) {
  const target = interaction.options.getUser('user', true);
  const basic = basicChecks(interaction, target);
  if (!basic.allowed) return { error: basic.reason };
  const member = interaction.guild.members.cache.get(target.id) ?? (await interaction.guild.members.fetch(target.id).catch(() => null));
  if (requireMember && !member) return { error: `<@${target.id}> n’est pas membre de ce serveur.` };
  if (member) {
    const hierarchy = canModerate(interaction.member, member);
    if (!hierarchy.allowed) return { error: hierarchy.reason };
  }
  return { user: target, member };
}

/**
 * Mêmes vérifications que `canModerate`/`basicChecks`, mais sans interaction Discord (utilisé par
 * le panel web) : bot, soi-même, propriétaire, puis hiérarchie de rôles. Les deux membres sont
 * récupérés auprès de Discord s'ils ne sont pas en cache : la hiérarchie n'est jamais sautée. Un
 * auteur absent du serveur n'est accepté que s'il est propriétaire du bot (`owners`).
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
async function checkSafety(client, guild, actorId, targetId, { owners } = {}) {
  if (targetId === client.user.id) return { allowed: false, reason: 'Impossible de sanctionner le bot lui-même.' };
  if (targetId === actorId) return { allowed: false, reason: 'Impossible de se sanctionner soi-même.' };
  if (targetId === guild.ownerId) return { allowed: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  const fetchMember = async (id) => guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
  const [actorMember, targetMember] = await Promise.all([fetchMember(actorId), fetchMember(targetId)]);
  if (!actorMember) {
    return owners?.has(actorId) ? { allowed: true } : { allowed: false, reason: 'Tu dois être membre de ce serveur pour y sanctionner quelqu’un.' };
  }
  if (targetMember && actorId !== guild.ownerId && targetMember.roles.highest.position >= actorMember.roles.highest.position) {
    return { allowed: false, reason: `<@${targetId}> a un rôle égal ou supérieur au tien : impossible de le sanctionner.` };
  }
  return { allowed: true };
}

module.exports = { canModerate, basicChecks, resolveTarget, checkSafety };
