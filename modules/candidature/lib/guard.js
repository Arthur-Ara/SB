'use strict';

const { PermissionFlagsBits } = require('discord.js');

/** Administrateur : propriétaire du bot ou du serveur, administrateur Discord. Voit et gère toutes les candidatures. */
function isAdmin(ctx, member) {
  if (!member) return false;
  if (ctx.config.owners.has(member.id)) return true;
  return member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
}

/** Recruteur d'une catégorie : un de ses rôles de recruteur, ou administrateur. */
function isRecruiter(ctx, member, category) {
  if (!member) return false;
  if (isAdmin(ctx, member)) return true;
  return Boolean(category?.recruiter_role_ids?.some((id) => member.roles.cache.has(String(id))));
}

/** Recruteur d'au moins une catégorie du serveur (ou administrateur). */
function isRecruiterAnywhere(ctx, member, categories) {
  return isAdmin(ctx, member) || categories.some((category) => isRecruiter(ctx, member, category));
}

module.exports = { isAdmin, isRecruiter, isRecruiterAnywhere };
