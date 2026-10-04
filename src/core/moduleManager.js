'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { GatewayIntentBits } = require('discord.js');

/**
 * Découvre et pilote les modules du dossier /modules.
 *
 * Structure d'un module (/modules/<nom>) :
 *   index.js     → définition : { name, label, emoji, description, intents, partials,
 *                                 required (non désactivable), defaultEnabled (true par défaut),
 *                                 init(ctx), ready(ctx), shutdown(ctx), web: { register(router, ctx) } }
 *   commands/    → slash commands du module
 *   events/      → écouteurs d'événements Discord
 *   migrations/  → fichiers .sql appliqués automatiquement au démarrage
 *
 * Chaque module reçoit un contexte : { config, db, client, commands, events, modules,
 * logger (préfixé), name, services (espace libre pour ses propres services) }.
 *
 * Les modules s'activent par serveur (/modules) : un module désactivé sur un serveur n'y reçoit
 * plus d'événements et ses commandes y sont refusées.
 */
class ModuleManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger.child('modules');
    this.directory = path.join(config.rootDir, 'modules');
    this.modules = new Map();
    this.guildStates = new Map();
    this.core = null;
  }

  // ── Activation par serveur ────────────────────────────────────────────────

  async loadGuildStates() {
    const rows = await this.core.db.query('SELECT guild_id, module, enabled FROM guild_modules');
    this.guildStates = new Map(rows.map((row) => [`${row.guild_id}:${row.module}`, Boolean(Number(row.enabled))]));
  }

  isEnabledFor(name, guildId) {
    const entry = this.modules.get(name);
    if (!entry) return false;
    if (!guildId || entry.definition.required) return true;
    const state = this.guildStates.get(`${guildId}:${name}`);
    return state ?? entry.definition.defaultEnabled ?? true;
  }

  async setEnabledFor(name, guildId, enabled, updatedBy) {
    const entry = this.modules.get(name);
    if (!entry) throw new Error(`Module inconnu : ${name}`);
    if (entry.definition.required && !enabled) throw new Error(`Le module ${name} ne peut pas être désactivé`);
    await this.core.db.query(
      `INSERT INTO guild_modules (guild_id, module, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [guildId, name, enabled ? 1 : 0, updatedBy, new Date()],
    );
    this.guildStates.set(`${guildId}:${name}`, Boolean(enabled));
  }

  labelOf(name) {
    return this.modules.get(name)?.definition.label ?? name;
  }

  discover() {
    if (!fs.existsSync(this.directory)) {
      this.logger.warn(`Dossier des modules introuvable : ${this.directory}`);
      return;
    }
    const entries = fs.readdirSync(this.directory, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      const dir = path.join(this.directory, entry.name);
      if (!fs.existsSync(path.join(dir, 'index.js'))) continue;
      const definition = require(dir);
      if (!definition?.name) {
        this.logger.warn(`Module "${entry.name}" ignoré : propriété "name" manquante`);
        continue;
      }
      if (this.config.modules.disabled.has(definition.name)) {
        this.logger.info(`Module "${definition.name}" désactivé (DISABLED_MODULES)`);
        continue;
      }
      if (this.modules.has(definition.name)) {
        throw new Error(`Deux modules portent le même nom : ${definition.name}`);
      }
      this.modules.set(definition.name, { definition, dir, ctx: null, handlersLoaded: false });
    }
    this.logger.info(`Modules détectés : ${[...this.modules.keys()].join(', ') || 'aucun'}`);
  }

  collectIntents() {
    const intents = new Set([GatewayIntentBits.Guilds]);
    for (const { definition } of this.modules.values()) {
      for (const intent of definition.intents ?? []) intents.add(intent);
    }
    return [...intents];
  }

  collectPartials() {
    const partials = new Set();
    for (const { definition } of this.modules.values()) {
      for (const partial of definition.partials ?? []) partials.add(partial);
    }
    return [...partials];
  }

  async initAll(core) {
    this.core = core;
    await this.loadGuildStates();
    for (const [name, entry] of this.modules) {
      const ctx = { ...core, name, logger: core.logger.child(name), services: {} };
      entry.ctx = ctx;
      await core.db.runMigrations(`module:${name}`, path.join(entry.dir, 'migrations'));
      if (typeof entry.definition.init === 'function') await entry.definition.init(ctx);
      this.loadHandlers(name);
    }
  }

  async readyAll() {
    for (const [name, entry] of this.modules) {
      if (typeof entry.definition.ready !== 'function') continue;
      try {
        await entry.definition.ready(entry.ctx);
      } catch (err) {
        this.logger.error(`Échec du démarrage du module ${name}`, err);
      }
    }
  }

  async shutdownAll() {
    for (const [name, entry] of [...this.modules].reverse()) {
      if (typeof entry.definition.shutdown !== 'function' || !entry.ctx) continue;
      try {
        await entry.definition.shutdown(entry.ctx);
      } catch (err) {
        this.logger.error(`Échec de l'arrêt du module ${name}`, err);
      }
    }
  }

  has(name) {
    return this.modules.has(name);
  }

  isLoaded(name) {
    return Boolean(this.modules.get(name)?.handlersLoaded);
  }

  /**
   * Accès en lecture aux services d'un autre module (ex : le module Whitelist consulte
   * `services('laisse').leash` pour savoir si un membre est présent grâce au système de laisse).
   * Renvoie `null` si le module est inconnu, désactivé ou pas encore initialisé — l'appelant doit
   * gérer ce cas comme « aucune information disponible », jamais comme une erreur.
   */
  services(name) {
    if (!this.isLoaded(name)) return null;
    return this.modules.get(name)?.ctx?.services ?? null;
  }

  /**
   * Appelle `ctx.services[hook](...args)` dans chaque module chargé (et activé sur `guildId`, si fourni) qui
   * le propose, et concatène les résultats. Sert aux opérations transverses — ex. `onChannelReplaced` après
   * /purge : chaque module rattache ses journaux et panels au salon recréé, sans que /purge les connaisse.
   * L'échec d'un module n'empêche pas les autres.
   */
  async callHook(hook, guildId, ...args) {
    const results = [];
    for (const [name, entry] of this.modules) {
      const fn = entry.ctx?.services?.[hook];
      if (typeof fn !== 'function' || !entry.handlersLoaded) continue;
      if (guildId && !this.isEnabledFor(name, guildId)) continue;
      try {
        const result = await fn(...args);
        if (result) results.push(...[].concat(result));
      } catch (err) {
        this.logger.warn(`${hook} : échec dans le module ${name}`, err.message);
      }
    }
    return results;
  }

  /** (Re)charge les commandes et événements d'un module depuis le disque. */
  loadHandlers(name) {
    const entry = this.modules.get(name);
    if (!entry) throw new Error(`Module inconnu : ${name}`);
    this.unloadHandlers(name);
    const commands = this.core.commands.loadFromDirectory(name, path.join(entry.dir, 'commands'), entry.ctx);
    const events = this.core.events.loadFromDirectory(name, path.join(entry.dir, 'events'), entry.ctx);
    entry.handlersLoaded = true;
    return { commands, events };
  }

  unloadHandlers(name) {
    const entry = this.modules.get(name);
    if (!entry) throw new Error(`Module inconnu : ${name}`);
    const commands = this.core.commands.unload(name);
    const events = this.core.events.unload(name);
    entry.handlersLoaded = false;
    return { commands, events };
  }

  list() {
    return [...this.modules.entries()].map(([name, entry]) => ({
      name,
      label: entry.definition.label ?? name,
      emoji: entry.definition.emoji ?? null,
      description: entry.definition.description ?? '',
      required: Boolean(entry.definition.required),
      defaultEnabled: entry.definition.defaultEnabled ?? true,
      loaded: entry.handlersLoaded,
      commands: this.core ? this.core.commands.namesFor(name) : [],
      events: this.core ? this.core.events.countFor(name) : 0,
      hasWeb: Boolean(entry.definition.web),
    }));
  }

  webEntries() {
    return [...this.modules.entries()]
      .filter(([, entry]) => entry.definition.web)
      .map(([name, entry]) => ({
        name,
        label: entry.definition.web.label ?? entry.definition.label ?? name,
        description: entry.definition.description ?? '',
        path: `/m/${name}/`,
      }));
  }

  /** Monte le routeur web de chaque module sous /m/<nom>/ (l'authentification est gérée en amont). */
  mountWeb(app) {
    for (const [name, entry] of this.modules) {
      const web = entry.definition.web;
      if (!web || typeof web.register !== 'function') continue;
      const router = express.Router();
      web.register(router, entry.ctx);
      app.use(`/m/${name}`, router);
      this.logger.info(`Interface web du module ${name} montée sur /m/${name}/`);
    }
  }
}

module.exports = { ModuleManager };
