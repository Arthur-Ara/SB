'use strict';

const { PermissionFlagsBits } = require('discord.js');

/**
 * Admin du module Laisse : membre ajouté via /laisse-admin set, administrateur du serveur,
 * propriétaire du serveur, ou propriétaire du bot.
 */
function isModuleAdmin(ctx, interaction, state) {
  const userId = interaction.user.id;
  return (
    ctx.services.leash.member(state, userId).admin ||
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) ||
    interaction.guild?.ownerId === userId ||
    ctx.config.owners.has(userId)
  );
}

module.exports = { isModuleAdmin };
