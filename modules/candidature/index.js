'use strict';

const { GatewayIntentBits } = require('discord.js');
const { CandidatureService } = require('./lib/service');
const { publishPanel } = require('./lib/lifecycle');
const registerWeb = require('./web/routes');

/**
 * Module Candidature : panels publiés dans un ou plusieurs salons, chacun avec ses catégories de candidature (salon
 * privé, modèle d'ouverture), suivi par statut (en attente, prise en compte, en traitement, attente entretien,
 * acceptée, refusée), changement de catégorie par les recruteurs, réponses automatiques, transcription de toutes les
 * candidatures et historique par candidat. Configuration sur le panel web (/m/candidature/).
 */
module.exports = {
  name: 'candidature',
  label: 'Candidatures',
  emoji: '📨',
  description: 'Candidatures par catégorie avec statuts, recruteurs, réponses automatiques et transcriptions.',
  // Fonctionnalités présentées sur la page « Fonctionnalités » du panel web.
  features: [
    'Panels de candidatures dans un ou plusieurs salons, avec leurs catégories',
    'Salon privé par candidature, modèle d’ouverture par catégorie',
    'Statuts : En attente, Prise en compte, En traitement, Attente entretien, Acceptée, Refusée — suivis avec /candidature status',
    'Refus motivé, délai de représentation, réponses automatiques par statut',
    'Acceptation : rôles, message privé, invitation à usage unique vers un autre serveur',
    'Changement de catégorie par les recruteurs, historique par candidat, transcription de chaque candidature',
  ],
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],

  async init(ctx) {
    const service = new CandidatureService({ db: ctx.db, logger: ctx.logger });
    await service.warmup();
    ctx.services.candidatures = service;

    /** Salon recréé (/purge) : journal et panels publiés suivent le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      const done = [];
      const settings = await service.settings(guild.id);
      if (settings.logChannelId === oldId) {
        await service.updateSettings(guild.id, { log_channel_id: newChannel.id });
        done.push('Journal des candidatures');
      }
      for (const panel of await service.panelsInChannel(oldId)) {
        const result = await publishPanel(ctx, guild, panel, newChannel).catch((err) => ({ error: err.message }));
        if (!result.error) done.push(`Panel de candidatures #${panel.id} republié`);
      }
      return done;
    };
  },

  web: { label: 'Candidatures', register: registerWeb },
};
