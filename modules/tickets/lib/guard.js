'use strict';

const { PermissionFlagsBits } = require('discord.js');

/** Administrateur du module (table ticket_admins), administrateur du serveur, propriétaire du serveur/bot. */
async function isTicketAdmin(ctx, member) {
  if (!member) return false;
  const guild = member.guild;
  if (ctx.config.owners.has(member.id)) return true;
  if (member.id === guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return ctx.services.tickets.isAdmin(guild.id, member.id);
}

/** 'mod' | 'helper' | null, selon les rôles du membre pour ce type de ticket précis. */
function roleAccess(type, member) {
  if (!member) return null;
  if (type.mod_role_ids.some((id) => member.roles.cache.has(id))) return 'mod';
  if (type.helper_role_ids.some((id) => member.roles.cache.has(id))) return 'helper';
  return null;
}

/** Le membre peut-il voir/écrire dans ce ticket précis (indépendamment de l'overwrite Discord déjà posé) ? */
async function canAccessTicket(ctx, ticket, type, member) {
  if (member.id === ticket.opener_id) return true;
  if (roleAccess(type, member)) return true;
  if (await isTicketAdmin(ctx, member)) return true;
  return ctx.services.tickets.isMember(ticket.id, member.id);
}

/** Fermer : mods/admins toujours, l'ouvreur seulement si `user_can_close` est activé pour ce type. */
async function canClose(ctx, ticket, type, member) {
  if (roleAccess(type, member) === 'mod') return true;
  if (await isTicketAdmin(ctx, member)) return true;
  if (member.id === ticket.opener_id && type.user_can_close) return true;
  return false;
}

/** Claim / ajouter / retirer un membre : réservé aux mods et admins du module (jamais les helpers). */
async function canManage(ctx, member, type) {
  if (roleAccess(type, member) === 'mod') return true;
  return isTicketAdmin(ctx, member);
}

/**
 * « Obliger à prendre en charge pour répondre » (réglage du type) : renvoie le motif du refus si ce membre du staff
 * ne peut pas répondre — ticket pas encore pris en charge, ou pris en charge par quelqu'un d'autre (seul celui qui l'a
 * pris répond ; pour reprendre la main, il faut d'abord le relâcher) — sinon null.
 */
function claimBlock(type, ticket, userId) {
  if (!Number(type?.claim_required)) return null;
  if (!ticket.claimed_by) return 'Prends en charge ce ticket (🙋 Prendre en charge) avant d’y répondre.';
  if (String(ticket.claimed_by) !== String(userId)) return `Ce ticket est pris en charge par <@${ticket.claimed_by}> : lui seul peut y répondre (le relâcher d’abord pour le reprendre).`;
  return null;
}

module.exports = { isTicketAdmin, roleAccess, canAccessTicket, canClose, canManage, claimBlock };
