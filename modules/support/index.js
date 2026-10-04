'use strict';

const { SupportService } = require('./lib/service');
const { SupportLogs } = require('./lib/logs');
const { publishPanel } = require('./lib/panel');
const registerWeb = require('./web/routes');

/**
 * Support automatique : un panel publié sur Discord propose une FAQ arborescente (catégories,
 * sous-catégories, réponses), avec possibilité d'ouvrir un ticket (module Tickets) si une réponse
 * ne suffit pas. Configuration entièrement sur le panel web (voir /support sur Discord) — aucune
 * commande de configuration côté Discord, volontairement.
 */
module.exports = {
  name: 'support',
  label: 'Support automatique',
  emoji: '❓',
  description: 'FAQ interactive (panels, catégories, réponses) avec ouverture de ticket si besoin.',
  // Fonctionnalités présentées sur la page « Fonctionnalités » du panel web.
  features: [
    'FAQ interactive : panels, catégories imbriquées et réponses',
    'Bouton « Créer un ticket » si la réponse ne suffit pas (module Tickets)',
    'Réponses réservées à certains rôles',
    'Statistiques d’efficacité : vues, avis utiles, tickets ouverts par réponse',
  ],
  defaultEnabled: false,

  async init(ctx) {
    const service = new SupportService({ db: ctx.db, logger: ctx.logger });
    const logs = new SupportLogs({ client: ctx.client, service, logger: ctx.logger });
    Object.assign(ctx.services, { support: service, logs });

    /** Salon recréé (/purge) : journal et panels publiés suivent le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      const done = [];
      if ((await service.settings(guild.id)).logChannelId === oldId) {
        await service.setLogChannel(guild.id, newChannel.id);
        done.push('Journal du support automatique');
      }
      for (const panel of await service.listPanels(guild.id)) {
        if (String(panel.channel_id) !== oldId) continue;
        const result = await publishPanel(ctx, service, panel, newChannel).catch((err) => ({ error: err.message }));
        if (!result.error) done.push(`Panel support #${panel.id} republié`);
      }
      return done;
    };
  },

  web: { label: 'Support automatique', register: registerWeb },
};
