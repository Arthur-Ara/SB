'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  InteractionContextType,
  ApplicationCommandOptionType,
  MessageFlags,
} = require('discord.js');
const ui = require('../ui');

const TIMEOUT_MS = 10 * 60_000;

function isSubOrGroup(option) {
  return option.type === ApplicationCommandOptionType.Subcommand || option.type === ApplicationCommandOptionType.SubcommandGroup;
}

/** « /laisse-admin limit <user> <nombre> » à partir de la définition JSON d'une commande. */
function usageLines(json, allowedNames) {
  const format = (path, option) => {
    const args = (option.options ?? [])
      .filter((o) => !isSubOrGroup(o))
      .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
      .join(' ');
    return `\`${[path, args].filter(Boolean).join(' ')}\` — ${option.description}`;
  };
  const subs = (json.options ?? []).filter(isSubOrGroup);
  if (!subs.length) return [format(`/${json.name}`, json)];
  const lines = [];
  for (const sub of subs) {
    if (allowedNames && !allowedNames.has(sub.name)) continue;
    if (sub.type === ApplicationCommandOptionType.SubcommandGroup) {
      for (const child of sub.options ?? []) lines.push(format(`/${json.name} ${sub.name} ${child.name}`, child));
    } else {
      lines.push(format(`/${json.name} ${sub.name}`, sub));
    }
  }
  return lines;
}

/**
 * Lignes d'aperçu d'une commande dans la liste d'un module : une ligne pour une commande
 * simple, une ligne par sous-commande/groupe autorisé pour une commande « mixte »
 * (ex : /laisse, dont une partie est publique et une partie réservée aux admins du module).
 */
function overviewLines(command, subset) {
  const json = command.data.toJSON();
  const subs = (json.options ?? []).filter(isSubOrGroup);
  if (!subs.length || !subset) return [`\`/${json.name}\` · ${json.description}`];
  const lines = [];
  for (const sub of subs) {
    if (!subset.has(sub.name)) continue;
    if (sub.type === ApplicationCommandOptionType.SubcommandGroup) {
      lines.push(`\`/${json.name} ${sub.name} …\` · ${sub.description} (${(sub.options ?? []).length} sous-commande(s))`);
    } else {
      lines.push(`\`/${json.name} ${sub.name}\` · ${sub.description}`);
    }
  }
  return lines;
}

/** La commande est-elle utilisable ici (serveur / MP), d'après les contextes déclarés ? */
function usableHere(command, interaction) {
  const contexts = command.data.toJSON().contexts;
  if (!contexts) return true;
  return contexts.includes(interaction.inGuild() ? InteractionContextType.Guild : InteractionContextType.BotDM);
}

function sortedModules(map) {
  return [...map.values()].sort((a, b) => (a.key === 'core' ? -1 : b.key === 'core' ? 1 : a.label.localeCompare(b.label)));
}

function addEntry(map, moduleMeta, command, subset) {
  if (!map.has(moduleMeta.key)) map.set(moduleMeta.key, { ...moduleMeta, entries: [] });
  map.get(moduleMeta.key).entries.push({ command, subset });
}

function countLines(entry) {
  return entry ? entry.entries.reduce((n, { command, subset }) => n + overviewLines(command, subset).length, 0) : 0;
}

/**
 * Sépare les commandes accessibles à l'utilisateur en deux jeux, par module. La distinction
 * public / admin ne reflète PAS qui peut effectivement lancer la commande (déjà filtré par
 * `core.commands.evaluate`, qui applique /permission) mais si son accès est piloté par une
 * notion d'« administrateur du module » propre à ce module :
 * - publicModules : toutes les commandes sans contrôle propre au module — y compris celles dont
 *   le défaut `/permission` est « admin » (ex. /ban, /modules, /stats) : seul le système /permission
 *   décide qui peut les lancer, ce n'est pas une notion d'admin du module ;
 * - adminModules : commandes réservées aux administrateurs du MODULE, dans l'un de ces cas :
 *     1. réservée aux propriétaires du bot (`ownerOnly`), en dehors de tout module ;
 *     2. commande entièrement gérée par son propre contrôle (`help.isAdmin(ctx, interaction)`,
 *        sans `adminSubcommands`/`adminGroups`) — ex. /laisse-admin, dont l'accès ne dépend pas
 *        du système de permissions mais du statut « admin du module » ;
 *     3. commande mixte, une partie publique et une partie admin, via `help.adminSubcommands`
 *        / `help.adminGroups` + `help.isAdmin`.
 */
async function splitCommands(core, interaction) {
  const moduleInfo = new Map(core.modules.list().map((m) => [m.name, m]));
  const publicModules = new Map();
  const adminModules = new Map();

  for (const command of [...core.commands.commands.values()].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
    if (!usableHere(command, interaction)) continue;
    const verdict = await core.commands.evaluate(interaction, command);
    if (!verdict.allowed) continue;

    const info = moduleInfo.get(command.module);
    const moduleMeta = {
      key: command.module,
      label: command.module === 'core' ? 'Général' : info?.label ?? command.module,
      emoji: command.module === 'core' ? ui.EMOJIS.gear : info?.emoji ?? ui.EMOJIS.modules,
    };

    if (command.ownerOnly) {
      addEntry(adminModules, moduleMeta, command, null);
      continue;
    }

    const help = command.help;
    const adminNames = new Set([...(help?.adminSubcommands ?? []), ...(help?.adminGroups ?? [])]);

    async function checkAdminHere() {
      if (!interaction.inGuild() || !help?.isAdmin) return false;
      try {
        return Boolean(await help.isAdmin(command.ctx, interaction));
      } catch (err) {
        core.logger.error(`/help : contrôle admin de /${command.data.name} impossible`, err);
        return false;
      }
    }

    // Commande entièrement gérée par son propre contrôle admin (pas de partie publique) — ex. /laisse-admin.
    if (help?.isAdmin && !adminNames.size) {
      if (await checkAdminHere()) addEntry(adminModules, moduleMeta, command, null);
      continue;
    }

    if (!adminNames.size) {
      addEntry(publicModules, moduleMeta, command, null);
      continue;
    }

    // Commande mixte : une partie publique, une partie réservée aux admins du module.
    const subs = (command.data.toJSON().options ?? []).filter(isSubOrGroup);
    const publicNames = new Set(subs.map((s) => s.name).filter((name) => !adminNames.has(name)));
    if (publicNames.size) addEntry(publicModules, moduleMeta, command, publicNames);
    if (await checkAdminHere()) addEntry(adminModules, moduleMeta, command, adminNames);
  }

  return { publicModules, adminModules };
}

module.exports = {
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder().setName('help').setDescription('Afficher les commandes que tu peux utiliser'),

  async execute(core, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { publicModules, adminModules } = await splitCommands(core, interaction);

    let bucket = publicModules.size ? 'public' : 'admin';
    let publicModuleKey = sortedModules(publicModules)[0]?.key ?? null;
    let adminModuleKey = sortedModules(adminModules)[0]?.key ?? null;
    let screen = 'list';
    let detail = null; // { bucket, moduleKey, commandName }

    const currentMap = () => (bucket === 'admin' ? adminModules : publicModules);
    const currentModuleKey = () => (bucket === 'admin' ? adminModuleKey : publicModuleKey);
    const setCurrentModuleKey = (key) => {
      if (bucket === 'admin') adminModuleKey = key;
      else publicModuleKey = key;
    };

    function renderToggle() {
      const buttons = [];
      if (bucket === 'public' && adminModules.size) {
        buttons.push(new ButtonBuilder().setCustomId('help:goto-admin').setLabel('🛡️ Commandes admin').setStyle(ButtonStyle.Secondary));
      }
      if (bucket === 'admin' && publicModules.size) {
        buttons.push(new ButtonBuilder().setCustomId('help:goto-public').setLabel('❮ Commandes publiques').setStyle(ButtonStyle.Secondary));
      }
      return buttons.length ? new ActionRowBuilder().addComponents(buttons) : null;
    }

    function renderList() {
      const map = currentMap();
      const modules = sortedModules(map);
      const activeKey = currentModuleKey();
      const activeEntry = map.get(activeKey);
      const totalLines = countLines(activeEntry);

      const moduleSelect =
        modules.length > 1
          ? new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('help:module')
                .setPlaceholder('Choisir un module…')
                .addOptions(
                  modules.map((m) => {
                    const option = new StringSelectMenuOptionBuilder()
                      .setLabel(m.label.slice(0, 100))
                      .setValue(m.key)
                      .setDescription(`${countLines(m)} commande(s)`.slice(0, 100))
                      .setDefault(m.key === activeKey);
                    if (m.emoji) option.setEmoji(m.emoji);
                    return option;
                  }),
                ),
            )
          : null;

      const detailSelect = activeEntry?.entries.length
        ? new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('help:detail')
              .setPlaceholder('Voir le détail d’une commande…')
              .addOptions(
                activeEntry.entries.slice(0, 25).map(({ command }) =>
                  new StringSelectMenuOptionBuilder()
                    .setLabel(`/${command.data.name}`)
                    .setValue(command.data.name)
                    .setDescription(command.data.description.slice(0, 100)),
                ),
              ),
          )
        : null;

      return ui.card({
        title: !activeEntry
          ? 'Aucune commande disponible ici.'
          : `Voici ${bucket === 'admin' ? 'tes commandes administratives' : 'les commandes disponibles'} — ${activeEntry.label}. (${totalLines})`,
        body: [
          { stats: [['Modules', modules.length], ['Commandes', totalLines]] },
          activeEntry
            ? { item: { emoji: activeEntry.emoji, title: activeEntry.label, lines: activeEntry.entries.flatMap(({ command, subset }) => overviewLines(command, subset)) } }
            : 'Aucune commande ne t’est accessible ici.',
          modules.length ? '\nChoisis un module ou une commande dans les menus ci-dessous.' : null,
          moduleSelect,
          detailSelect,
          renderToggle(),
        ],
      });
    }

    function renderDetail() {
      const map = detail.bucket === 'admin' ? adminModules : publicModules;
      const entry = map.get(detail.moduleKey);
      const found = entry?.entries.find((e) => e.command.data.name === detail.commandName);
      if (!found) {
        screen = 'list';
        return renderList();
      }
      const lines = usageLines(found.command.data.toJSON(), found.subset);
      return ui.card({
        title: `Détail de la commande /${detail.commandName}. (${lines.length})`,
        body: [
          { details: [found.command.data.description, '<paramètre> obligatoire · [paramètre] facultatif'] },
          lines.join('\n'),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('help:back').setLabel('❮ Retour').setStyle(ButtonStyle.Secondary)),
        ],
      });
    }

    const render = () => (screen === 'detail' ? renderDetail() : renderList());

    const message = await ui.respond(interaction, render());
    if (!publicModules.size && !adminModules.size) return;

    const collector = message.createMessageComponentCollector({ time: TIMEOUT_MS });
    collector.on('collect', async (component) => {
      if (component.user.id !== interaction.user.id) return ui.rejectForeignClick(component);
      if (component.customId === 'help:module') {
        setCurrentModuleKey(component.values[0]);
        screen = 'list';
      } else if (component.customId === 'help:detail') {
        detail = { bucket, moduleKey: currentModuleKey(), commandName: component.values[0] };
        screen = 'detail';
      } else if (component.customId === 'help:goto-admin') {
        bucket = 'admin';
        screen = 'list';
      } else if (component.customId === 'help:goto-public') {
        bucket = 'public';
        screen = 'list';
      } else if (component.customId === 'help:back') {
        bucket = detail.bucket;
        screen = 'list';
      }
      return component.update(ui.message(render())).catch(() => {});
    });
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};
