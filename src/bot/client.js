'use strict';

const { Client, Options } = require('discord.js');

/** Crée le client Discord avec l'union des intents/partials déclarés par les modules. */
function createClient({ intents, partials }) {
  return new Client({
    intents,
    partials,
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
    }),
    // Le bot ne notifie jamais personne par accident dans ses réponses.
    allowedMentions: { parse: [], repliedUser: false },
  });
}

module.exports = { createClient };
