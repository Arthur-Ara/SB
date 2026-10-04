'use strict';

const { PermissionFlagsBits } = require('discord.js');

/** Types de rollback : changements journalisés concernés (la modération est lue dans moderation_actions). */
const SCOPE_KINDS = {
  all: ['channel', 'role', 'member_role'],
  rank: ['role', 'member_role'],
  channel: ['channel'],
  moderation: [],
};

const SCOPE_LABEL = { all: 'Tout', rank: 'Rôles', channel: 'Salons', moderation: 'Modération' };

/** Permission Discord exigée de l'auteur de la commande, par type de rollback. */
const SCOPE_PERMISSION = {
  all: PermissionFlagsBits.Administrator,
  rank: PermissionFlagsBits.ManageRoles,
  channel: PermissionFlagsBits.ManageChannels,
  moderation: PermissionFlagsBits.ModerateMembers,
};

const SCOPE_PERMISSION_LABEL = {
  all: 'Administrateur',
  rank: 'Gérer les rôles',
  channel: 'Gérer les salons',
  moderation: 'Exclure temporairement des membres',
};

/** Sanctions de modération que l'on sait annuler (kick, purge, suppression de messages : irréversibles). */
const MOD_REVERSIBLE = ['ban', 'tempban', 'tempmute', 'tempvocmute', 'warn', 'shadowban', 'lock'];

/** Au-delà de ce nombre d'actions (ou pour « Tout », ou si une suppression est prévue), la confirmation est renforcée. */
const SENSITIVE_COUNT = 10;

module.exports = { SCOPE_KINDS, SCOPE_LABEL, SCOPE_PERMISSION, SCOPE_PERMISSION_LABEL, MOD_REVERSIBLE, SENSITIVE_COUNT };
