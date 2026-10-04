'use strict';

const path = require('node:path');
const { Guild } = require('discord.js');
const { listJsFiles, freshRequire, forget } = require('./fsUtils');

/** Serveur concerné par un événement (message, membre, état vocal, serveur…), ou null (ex : userUpdate). */
function guildIdOf(args) {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    if (arg instanceof Guild) return arg.id;
    if (typeof arg.guildId === 'string') return arg.guildId;
    if (arg.guild?.id) return arg.guild.id;
  }
  return null;
}

/**
 * Gestionnaire d'événements Discord.
 *
 * Chaque fichier d'événement exporte : { event: Events.X, execute(ctx, ...args) }.
 * Un seul listener discord.js est posé par type d'événement ; il redistribue
 * l'événement à tous les modules abonnés (une erreur dans un module n'affecte pas les autres).
 */
class EventHandler {
  constructor(core) {
    this.core = core;
    this.logger = core.logger.child('événements');
    this.handlers = new Map();
    this.attached = new Set();
  }

  loadFromDirectory(moduleName, dir, ctx) {
    const loaded = [];
    for (const file of listJsFiles(dir)) {
      let handler;
      try {
        handler = freshRequire(file);
      } catch (err) {
        this.logger.error(`Impossible de charger ${moduleName}/${path.basename(file)}`, err);
        continue;
      }
      if (!handler?.event || typeof handler.execute !== 'function') {
        this.logger.warn(`${moduleName}/${path.basename(file)} ignoré : "event" ou "execute" manquant`);
        continue;
      }
      if (!this.handlers.has(handler.event)) this.handlers.set(handler.event, []);
      this.handlers.get(handler.event).push({ module: moduleName, file, execute: handler.execute, ctx });
      this.attach(handler.event);
      loaded.push(handler.event);
    }
    if (loaded.length) this.logger.info(`${moduleName} : ${loaded.length} écouteur(s) (${loaded.join(', ')})`);
    return loaded;
  }

  unload(moduleName) {
    let removed = 0;
    for (const [event, list] of this.handlers) {
      const kept = [];
      for (const handler of list) {
        if (handler.module === moduleName) {
          forget(handler.file);
          removed += 1;
        } else {
          kept.push(handler);
        }
      }
      this.handlers.set(event, kept);
    }
    return removed;
  }

  countFor(moduleName) {
    let count = 0;
    for (const list of this.handlers.values()) count += list.filter((h) => h.module === moduleName).length;
    return count;
  }

  attach(event) {
    if (this.attached.has(event)) return;
    this.attached.add(event);
    this.core.client.on(event, (...args) => {
      this.dispatch(event, args);
    });
  }

  async dispatch(event, args) {
    const list = this.handlers.get(event);
    if (!list?.length) return;
    const guildId = guildIdOf(args);
    await Promise.all(
      list.map(async (handler) => {
        // Module désactivé sur ce serveur (/modules) : l'événement ne lui est pas transmis.
        if (guildId && handler.module !== 'core' && !this.core.modules.isEnabledFor(handler.module, guildId)) return;
        try {
          await handler.execute(handler.ctx, ...args);
        } catch (err) {
          this.logger.error(`Erreur dans ${handler.module}/${path.basename(handler.file)} (${event})`, err);
        }
      }),
    );
  }
}

module.exports = { EventHandler };
