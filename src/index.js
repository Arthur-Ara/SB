'use strict';

const path = require('node:path');
const { Events, OAuth2Scopes, PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('./core/logger');

const logger = createLogger('core');

process.on('unhandledRejection', (reason) => logger.error('Promesse rejetée non gérée', reason));

async function main() {
  const config = require('./config');
  const { Database } = require('./core/database');
  const { ModuleManager } = require('./core/moduleManager');
  const { CommandHandler } = require('./core/commandHandler');
  const { EventHandler } = require('./core/eventHandler');
  const { createClient } = require('./bot/client');
  const { startWebServer } = require('./web/server');

  // 0. Version (package.json) et cohérence avec le changelog : chaque mise à jour doit y avoir son entrée.
  const { version } = require('../package.json');
  const latest = require('./core/changelog').loadChangelog()[0];
  logger.info(`SciensBot v${version}`);
  if (!latest || latest.version !== version) {
    logger.warn(`changelog.json ne décrit pas la version ${version} (dernière entrée : ${latest ? `v${latest.version}` : 'aucune'}) : pensez à le compléter.`);
  }

  // 1. Base de données + migrations du cœur
  const db = new Database(config.db, logger.child('db'));
  await db.connect();
  await db.runMigrations('core', path.join(__dirname, 'core', 'migrations'));

  // 1 bis. Admins globaux (/admin) : ajoutés aux propriétaires et aux comptes autorisés du panel web.
  const { BotAdmins } = require('./core/botAdmins');
  const botAdmins = new BotAdmins({ db, config, logger });
  await botAdmins.load();

  // 2. Découverte des modules (leurs intents déterminent la configuration du client)
  const modules = new ModuleManager({ config, logger });
  modules.discover();
  const client = createClient({ intents: modules.collectIntents(), partials: modules.collectPartials() });

  // 3. Contexte partagé + gestionnaires dynamiques
  const core = { config, db, client, logger, modules, botAdmins };
  core.commands = new CommandHandler(core);
  core.events = new EventHandler(core);
  core.commands.loadFromDirectory('core', path.join(__dirname, 'bot', 'commands'), core);

  await modules.initAll(core);

  client.on(Events.InteractionCreate, (interaction) => core.commands.handle(interaction));
  client.on(Events.Error, (err) => logger.error('Erreur du client Discord', err));
  client.on(Events.Warn, (message) => logger.warn(message));
  client.once(Events.ClientReady, async () => {
    logger.info(`Connecté en tant que ${client.user.tag} sur ${client.guilds.cache.size} serveur(s)`);
    // Permissions demandées à l'invitation : l'union de ce dont les modules ont besoin (pas « Administrateur »).
    const invite = client.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions, // RôleMenu (menus à réactions)
        PermissionFlagsBits.UseExternalEmojis,
        PermissionFlagsBits.ManageMessages, // Modération (/clear), RôleMenu (retrait des réactions)
        PermissionFlagsBits.ManageChannels, // Tickets, modmail, prison du shadow-ban, /lock, /purge, rollback
        PermissionFlagsBits.ManageRoles, // RôleMenu, permissions des salons de tickets, rollback
        PermissionFlagsBits.ManageWebhooks, // Tickets (réponses depuis le panel web)
        PermissionFlagsBits.ViewAuditLog, // Statistiques, Server Manager, auteurs des bans
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ModerateMembers, // exclusions temporaires (/tempmute)
        PermissionFlagsBits.MuteMembers, // /tempvocmute
        PermissionFlagsBits.MoveMembers, // modules Laisse et Whitelist Vocal (déplacer / déconnecter des membres)
        PermissionFlagsBits.ManageGuild, // Statistiques (suivi des invitations : lecture des invitations et de l'URL personnalisée), sauvegardes
      ],
    });
    logger.info(`Lien d'invitation : ${invite}`);
    try {
      await core.commands.deploy();
      await core.commands.removeGuildCopies();
    } catch (err) {
      logger.error('Publication des slash commands impossible', err);
    }
    await modules.readyAll();
  });

  // 4. Dashboard web
  const web = config.web.enabled ? await startWebServer(core) : null;

  // 5. Connexion à Discord
  await client.login(config.discord.token);

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info(`Arrêt demandé (${signal})…`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await modules.shutdownAll();
    await web?.close().catch(() => {});
    await client.destroy();
    await db.close().catch(() => {});
    logger.info('Arrêt terminé.');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Démarrage impossible', err);
  if (/disallowed intents/i.test(err?.message ?? '')) {
    logger.error(
      'Activez « Server Members Intent » et « Message Content Intent » dans le portail développeur Discord (onglet Bot).',
    );
  }
  process.exit(1);
});
