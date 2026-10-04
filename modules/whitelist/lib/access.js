'use strict';

const { PermissionFlagsBits } = require('discord.js');

/**
 * Admin du module Whitelist : membre ajouté via /whitelist admin set, administrateur du serveur,
 * propriétaire du serveur, ou propriétaire du bot. Exempté de la whitelist et de la limite de
 * slots, et seul autorisé à utiliser /whitelist.
 *
 * @param {object} ctx
 * @param {{ id: string, guild: { ownerId: string }, permissions: import('discord.js').PermissionsBitField }} member
 *   Un GuildMember (en vocal ou via une interaction) — les deux exposent id/guild/permissions.
 * @param {{ admins: Set<string> }} state
 */
function isModuleAdmin(ctx, member, state) {
  return (
    state.admins.has(member.id) ||
    Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator)) ||
    member.guild?.ownerId === member.id ||
    ctx.config.owners.has(member.id)
  );
}

module.exports = { isModuleAdmin };
