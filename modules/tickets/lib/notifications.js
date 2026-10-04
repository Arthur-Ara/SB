'use strict';

const { hasWebRight, memberOf } = require('../../permissions/lib/webAccess');
const { isTicketAdmin, roleAccess } = require('./guard');

/** Colonne JSON des rôles staff : déjà décodée par le pilote MySQL, ou texte JSON. */
function rolesOf(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Notifications du panel (hook `webNotifications`) : tickets dont l'ouvreur attend une réponse du staff et
 * fils modmail ouverts, par serveur où le compte a le droit de voir les tickets — et seulement ceux qu'il peut voir
 * (même portée que le panel : types dont il a un rôle, catégories modmail dont il est staff ; tout pour un admin).
 */
async function ticketNotifications(ctx, userId) {
  const [waiting, modmail] = await Promise.all([
    ctx.db.query(
      `SELECT guild_id, type_id, COUNT(*) AS n, MAX(last_message_at) AS at FROM tickets
        WHERE status = 'open' AND last_message_is_staff = 0 AND first_opener_message_at IS NOT NULL GROUP BY guild_id, type_id`,
    ),
    ctx.db.query(`SELECT guild_id, category_id, staff_role_ids, COALESCE(last_message_at, created_at) AS at FROM modmail_threads WHERE status = 'open'`),
  ]);

  // Portée du compte, par serveur (calculée une fois).
  const scopes = new Map();
  const scopeOf = async (guildId) => {
    const key = String(guildId);
    if (scopes.has(key)) return scopes.get(key);
    let scope = null;
    const guild = ctx.client.guilds.cache.get(key);
    if (guild && ctx.modules.isEnabledFor('tickets', guild.id) && (await hasWebRight(ctx, guild, userId, 'tickets', 'view-tickets'))) {
      const member = await memberOf(guild, userId);
      const admin = ctx.config.owners.has(userId) || (member ? await isTicketAdmin(ctx, member) : false);
      const [types, categories] = admin ? [[], []] : await Promise.all([ctx.services.tickets.listAllTypes(guild.id), ctx.services.tickets.listModmailCategories(guild.id)]);
      scope = {
        guild,
        admin,
        member,
        typeIds: new Set(types.filter((type) => member && roleAccess(type, member)).map((type) => String(type.id))),
        categories: new Map(categories.map((c) => [String(c.id), c])),
      };
    }
    scopes.set(key, scope);
    return scope;
  };
  const hasRole = (member, ids) => Boolean(member) && ids.some((id) => member.roles.cache.has(String(id)));

  const totals = new Map(); // guildId → { tickets, ticketsAt, modmail, modmailAt }
  const bump = (scope, field, n, at) => {
    const entry = totals.get(scope.guild.id) ?? { scope, tickets: 0, ticketsAt: null, modmail: 0, modmailAt: null };
    entry[field] += n;
    const atField = `${field}At`;
    if (at && (!entry[atField] || new Date(at) > new Date(entry[atField]))) entry[atField] = at;
    totals.set(scope.guild.id, entry);
  };

  for (const row of waiting) {
    const scope = await scopeOf(row.guild_id);
    if (scope && (scope.admin || scope.typeIds.has(String(row.type_id)))) bump(scope, 'tickets', Number(row.n), row.at);
  }
  for (const row of modmail) {
    const scope = await scopeOf(row.guild_id);
    if (!scope) continue;
    const roles = rolesOf(row.staff_role_ids);
    const current = scope.categories.get(String(row.category_id))?.staff_role_ids ?? [];
    if (scope.admin || hasRole(scope.member, [...roles, ...current])) bump(scope, 'modmail', 1, row.at);
  }

  const items = [];
  for (const { scope, tickets, ticketsAt, modmail: threads, modmailAt } of totals.values()) {
    if (tickets) items.push({ module: 'tickets', emoji: '🎫', guildName: scope.guild.name, text: `${tickets} ticket${tickets > 1 ? 's' : ''} en attente d’une réponse du staff`, href: '/m/tickets/', at: ticketsAt });
    if (threads) items.push({ module: 'tickets', emoji: '📨', guildName: scope.guild.name, text: `${threads} conversation${threads > 1 ? 's' : ''} modmail ouverte${threads > 1 ? 's' : ''}`, href: '/m/tickets/', at: modmailAt });
  }
  return items;
}

module.exports = { ticketNotifications };
