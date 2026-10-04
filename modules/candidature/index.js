'use strict';

const { GatewayIntentBits } = require('discord.js');
const { CandidatureService } = require('./lib/service');
const { publishPanel, refreshPanel } = require('./lib/lifecycle');
const registerWeb = require('./web/routes');

/**
 * Module Candidature : dépôt de candidatures par catégorie (salon privé, modèle d'ouverture, formulaire facultatif),
 * suivi par statut (en attente, prise en compte, en traitement, attente entretien, acceptée, refusée), changement de
 * catégorie par les recruteurs, contrôle automatique des critères, réponses automatiques, transcription de toutes
 * les candidatures et historique par candidat. Configuration sur le panel web (/m/candidature/).
 */
module.exports = {
  name: 'candidature',
  label: 'Candidatures',
  emoji: '📨',
  description: 'Candidatures par catégorie avec statuts, recruteurs, contrôle automatique des critères et transcriptions.',
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],

  async init(ctx) {
    const service = new CandidatureService({ db: ctx.db, logger: ctx.logger });
    await service.warmup();
    ctx.services.candidatures = service;

    /** Salon recréé (/purge) : journal et panel publié suivent le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      const done = [];
      const settings = await service.settings(guild.id);
      if (settings.logChannelId === oldId) {
        await service.updateSettings(guild.id, { log_channel_id: newChannel.id });
        done.push('Journal des candidatures');
      }
      if (settings.panel.channelId === oldId) {
        const result = await publishPanel(ctx, guild, newChannel).catch((err) => ({ error: err.message }));
        if (!result.error) done.push('Panel de candidatures republié');
      }
      return done;
    };
    ctx.services.refreshPanel = (guild) => refreshPanel(ctx, guild);
  },

  web: { label: 'Candidatures', register: registerWeb },
};
