'use strict';

const { GatewayIntentBits, Partials } = require('discord.js');
const { RoleMenuService } = require('./lib/service');
const { RoleMenuLogs } = require('./lib/logs');
const { ConditionRegistry } = require('./lib/conditions');
const { RoleMenuEngine } = require('./lib/engine');
const { RoleMenuConfig } = require('./lib/config');
const { RoleMenuPanel } = require('./lib/panel');
const registerWeb = require('./web/routes');

/**
 * Module RôleMenu : menus de rôles à réactions, boutons ou menu déroulant (plusieurs rôles ou un seul parmi la
 * liste) et conditions d'accès extensibles (rôles, ancienneté… et, plus tard, niveaux ou invitations).
 * Configuration par le panneau interactif de /rolemenu (Discord) ou depuis le panel web.
 * Spécifications : rolemenu.md
 */
module.exports = {
  name: 'rolemenu',
  label: 'RôleMenu',
  emoji: '🎭',
  description: 'Menus de rôles (réactions, boutons, menu déroulant) avec conditions d’accès.',
  // Fonctionnalités présentées sur la page « Fonctionnalités » du panel web.
  features: [
    'Menus de rôles en réactions, boutons ou menu déroulant',
    'Un seul rôle ou plusieurs (maximum facultatif), retrait autorisé ou non',
    'Menu déroulant : les rôles déjà possédés sont présélectionnés dans la réponse pour les modifier facilement',
    'Conditions d’accès cumulables : rôles, ancienneté, compte, booster',
    'Configuration depuis Discord (/rolemenu) ou le panel web, garde-fous sur les rôles sensibles',
  ],
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],

  async init(ctx) {
    const { env } = ctx.config;
    // ROLEMENU_ALLOW_SENSITIVE_ROLES ; l'ancien nom (AUTOROLE_…) reste lu pour ne pas casser un .env existant.
    const allowSensitive = env.bool('ROLEMENU_ALLOW_SENSITIVE_ROLES', env.bool('AUTOROLE_ALLOW_SENSITIVE_ROLES', false));
    const service = new RoleMenuService({ db: ctx.db, logger: ctx.logger });
    const logs = new RoleMenuLogs({ client: ctx.client, service, logger: ctx.logger });
    const conditions = new ConditionRegistry();
    const engine = new RoleMenuEngine({ service, conditions, logger: ctx.logger, allowSensitive });
    const config = new RoleMenuConfig({ client: ctx.client, service, conditions, logs, logger: ctx.logger, allowSensitive });
    const panel = new RoleMenuPanel({ ctx });
    // `conditions` est exposé aux autres modules : ctx.modules.services('rolemenu')?.conditions.register(…)
    Object.assign(ctx.services, { rolemenu: service, logs, conditions, engine, config, panel, allowSensitive });

    /** Salon recréé (/purge) : journal et menus publiés suivent le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel, actor) => {
      const done = [];
      if ((await service.settings(guild.id)).logChannelId === oldId) {
        await service.setLogChannel(guild.id, newChannel.id);
        done.push('Journal de RôleMenu');
      }
      for (const menu of await service.listMenus(guild.id)) {
        if (String(menu.channel_id) !== oldId) continue;
        const result = await config.publish(guild, actor, menu.id, newChannel);
        if (!result.error) done.push(`Menu de rôles « ${menu.name} » republié`);
      }
      return done;
    };
  },

  web: { label: 'RôleMenu', register: registerWeb },
};
