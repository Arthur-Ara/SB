'use strict';

const path = require('node:path');
const { Collection, RESTJSONErrorCodes, Routes } = require('discord.js');
const { listJsFiles, freshRequire, forget } = require('./fsUtils');
const ui = require('../bot/ui');

/**
 * Gestionnaire de slash commands.
 *
 * Chaque fichier de commande exporte :
 *   { data: SlashCommandBuilder, execute(ctx, interaction), autocomplete?(ctx, interaction),
 *     ownerOnly?: boolean,                      // réservée aux propriétaires du bot (BOT_OWNERS)
 *     permission?: { default: 'admin' | 'everyone' } } // accès par défaut (module Permissions)
 *
 * Les commandes sont rattachées à un module : on peut les charger, décharger ou
 * recharger module par module, puis republier la liste auprès de Discord (deploy).
 * Avant chaque exécution : module activé sur le serveur, puis gardes enregistrés via use().
 */
class CommandHandler {
  constructor(core) {
    this.core = core;
    this.logger = core.logger.child('commandes');
    this.commands = new Collection();
    this.guards = [];
  }

  loadFromDirectory(moduleName, dir, ctx) {
    const loaded = [];
    for (const file of listJsFiles(dir)) {
      let command;
      try {
        command = freshRequire(file);
      } catch (err) {
        this.logger.error(`Impossible de charger ${moduleName}/${path.basename(file)}`, err);
        continue;
      }
      if (!command?.data?.name || typeof command.execute !== 'function') {
        this.logger.warn(`${moduleName}/${path.basename(file)} ignoré : "data" ou "execute" manquant`);
        continue;
      }
      const name = command.data.name;
      const existing = this.commands.get(name);
      if (existing && existing.module !== moduleName) {
        this.logger.warn(`Conflit : /${name} (${moduleName}) déjà fourni par le module ${existing.module}, ignoré`);
        continue;
      }
      this.commands.set(name, { ...command, module: moduleName, file, ctx });
      loaded.push(name);
    }
    if (loaded.length) this.logger.info(`${moduleName} : ${loaded.map((name) => `/${name}`).join(', ')}`);
    return loaded;
  }

  unload(moduleName) {
    const removed = [];
    for (const [name, command] of this.commands) {
      if (command.module !== moduleName) continue;
      forget(command.file);
      this.commands.delete(name);
      removed.push(name);
    }
    return removed;
  }

  namesFor(moduleName) {
    return [...this.commands.values()].filter((c) => c.module === moduleName).map((c) => c.data.name);
  }

  /** Publie l'ensemble des commandes chargées, globalement (remplace la liste existante côté Discord). */
  async deploy() {
    const { clientId } = this.core.config.discord;
    const { client } = this.core;
    // L'ID de l'application réellement connectée fait foi (évite un DISCORD_CLIENT_ID erroné).
    const applicationId = client.application?.id ?? clientId;
    if (applicationId !== clientId) {
      this.logger.warn(
        `DISCORD_CLIENT_ID (${clientId}) ne correspond pas au bot connecté (application ${applicationId}). ` +
          'Les commandes utilisent l’ID du bot, mais la connexion au dashboard échouera tant que ' +
          'DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET ne viennent pas de la même application que le token.',
      );
    }
    const body = this.commands.map((command) => command.data.toJSON());
    await client.rest.put(Routes.applicationCommands(applicationId), { body });
    this.logger.info(`${body.length} slash command(s) publiée(s) globalement`);
  }

  /**
   * Supprime les copies de commandes enregistrées sur des serveurs (ancien mode « serveur de test ») :
   * sans cela, elles s'afficheraient en double avec les commandes globales.
   */
  async removeGuildCopies() {
    for (const guild of this.core.client.guilds.cache.values()) {
      try {
        const existing = await guild.commands.fetch();
        if (!existing.size) continue;
        await guild.commands.set([]);
        this.logger.info(`${existing.size} commande(s) en double supprimée(s) sur « ${guild.name} »`);
      } catch (err) {
        if (err?.code !== RESTJSONErrorCodes.MissingAccess) {
          this.logger.warn(`Nettoyage des commandes de « ${guild.name} » impossible`, err.message);
        }
      }
    }
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;
    const command = this.commands.get(interaction.commandName);

    if (interaction.isAutocomplete()) {
      if (!command?.autocomplete) return;
      try {
        await command.autocomplete(command.ctx, interaction);
      } catch (err) {
        this.logger.error(`Autocomplétion /${interaction.commandName}`, err);
      }
      return;
    }

    if (!command) {
      await ui.replyError(interaction, 'Cette commande est indisponible (module déchargé ?).').catch(() => {});
      return;
    }

    const verdict = await this.evaluate(interaction, command);
    if (!verdict.allowed) {
      await ui.replyError(interaction, verdict.reason, 'Accès refusé', ui.EMOJIS.permissions).catch(() => {});
      return;
    }

    try {
      await command.execute(command.ctx, interaction);
    } catch (err) {
      this.logger.error(`Erreur dans /${interaction.commandName} (${command.module})`, err);
      await ui.replyError(interaction, 'Une erreur est survenue pendant l’exécution de la commande.').catch(() => {});
    }
  }

  /**
   * Middlewares d'autorisation (ex : module Permissions). Un garde reçoit (interaction, command)
   * et renvoie { allowed: false, reason } pour bloquer l'exécution, ou rien pour laisser passer.
   */
  use(guard) {
    this.guards.push(guard);
  }

  /**
   * L'utilisateur peut-il lancer cette commande ici ? (propriétaires du bot, module activé
   * sur le serveur, puis gardes). N'envoie aucune réponse : utilisé aussi par /help.
   * @returns {Promise<{ allowed: boolean, reason?: string }>}
   */
  async evaluate(interaction, command) {
    if (command.ownerOnly) {
      return this.core.config.owners.has(interaction.user.id)
        ? { allowed: true }
        : { allowed: false, reason: 'Commande réservée aux propriétaires du bot.' };
    }
    if (interaction.inGuild() && command.module !== 'core' && !this.core.modules.isEnabledFor(command.module, interaction.guildId)) {
      return {
        allowed: false,
        reason: `Le module **${this.core.modules.labelOf(command.module)}** est désactivé sur ce serveur (voir \`/modules\`).`,
      };
    }
    for (const guard of this.guards) {
      let verdict;
      try {
        verdict = await guard(interaction, command);
      } catch (err) {
        this.logger.error(`Contrôle d'accès de /${command.data.name} impossible`, err);
        verdict = { allowed: false, reason: 'Le contrôle des permissions a échoué, réessayez plus tard.' };
      }
      if (verdict && verdict.allowed === false) {
        return { allowed: false, reason: verdict.reason ?? 'Vous n’avez pas la permission d’utiliser cette commande.' };
      }
    }
    return { allowed: true };
  }

  /** Commandes que l'auteur de l'interaction peut utiliser à cet endroit (pour /help). */
  async availableFor(interaction) {
    const available = [];
    for (const command of this.commands.values()) {
      if ((await this.evaluate(interaction, command)).allowed) available.push(command);
    }
    return available;
  }

  /** Commandes dont l'accès peut être réglé par serveur (toutes sauf celles réservées aux propriétaires du bot). */
  manageableCommands() {
    return [...this.commands.values()].filter((command) => !command.ownerOnly);
  }
}

module.exports = { CommandHandler };
