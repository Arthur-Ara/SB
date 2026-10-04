'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  RESTJSONErrorCodes,
} = require('discord.js');
const ui = require('../ui');
const { loadChangelog, findVersion, groupByType } = require('../../core/changelog');
const { webUrl } = require('../../web/url');

// Discord limite le texte d'un message en composants v2 à 4000 caractères au total : au-delà, la liste continue
// dans un message de suite (marge gardée pour l'en-tête et le pied). Au plus MAX_MESSAGES messages.
const TEXT_BUDGET = 3600;
const MAX_MESSAGES = 4;

function formatDate(iso) {
  if (!iso) return null;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function moduleLabel(core, key) {
  if (key === 'core') return 'Général';
  if (key === 'web') return 'Panel web';
  return core.modules.labelOf(key);
}

/**
 * Répartit les modifications d'une version en pages de texte (une page = un message), sans jamais couper une
 * ligne : [{ blocks: [{ title, lines }] }]. `hidden` : lignes au-delà de MAX_MESSAGES messages (rare).
 */
function paginate(core, entry, headerLength) {
  const pages = [{ used: headerLength, blocks: [] }];
  let hidden = 0;
  for (const group of groupByType(entry)) {
    const title = `### ${group.emoji} ${group.label}`;
    for (const change of group.changes) {
      const line = `- **${moduleLabel(core, change.module)}** · ${change.text}`;
      let page = pages[pages.length - 1];
      let block = page.blocks[page.blocks.length - 1];
      const needsTitle = !block || block.type !== group.type;
      const cost = line.length + 1 + (needsTitle ? title.length + 1 : 0);
      if (page.used + cost > TEXT_BUDGET) {
        if (pages.length >= MAX_MESSAGES) {
          hidden += 1;
          continue;
        }
        page = { used: headerLength, blocks: [] };
        pages.push(page);
        block = null;
      }
      if (!block || block.type !== group.type) {
        block = { type: group.type, title, lines: [] };
        page.blocks.push(block);
        page.used += title.length + 1;
      }
      block.lines.push(line);
      page.used += line.length + 1;
    }
  }
  return { pages, hidden };
}

/**
 * Messages « embed v2 » (conteneurs de composants) d'une version : même charte sombre que les cartes du bot
 * (barre #2B2D31, titre « ・ … »), modifications regroupées par catégorie, module en gras devant chaque ligne.
 * Le dernier message porte le total et le bouton vers le changelog complet du panel web.
 */
function changelogMessages(core, entry, url) {
  const subtitle = [formatDate(entry.date), entry.title].filter(Boolean).join(' · ');
  // Modules concernés par la version, sous son titre (ordre d'apparition dans le changelog).
  const modules = [...new Set(entry.changes.map((change) => change.module))].map((key) => `\`${moduleLabel(core, key)}\``).join(' ');
  const header = (index, count) =>
    `## ・ Changelog — v${entry.version}${count > 1 ? ` (${index + 1}/${count})` : ''}${index === 0 && subtitle ? `\n-# ${subtitle}` : ''}${
      index === 0 && modules ? `\n${modules}` : ''
    }`;
  const { pages, hidden } = paginate(core, entry, header(0, MAX_MESSAGES).length);

  return pages.map((page, index) => {
    const container = new ContainerBuilder()
      .setAccentColor(ui.DARK)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(header(index, pages.length)))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const block of page.blocks) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${block.title}\n${block.lines.join('\n')}`));
    }
    if (index === pages.length - 1) {
      const total = entry.changes.length;
      const footer = `-# ${total} modification${total > 1 ? 's' : ''}${hidden ? ` · ${hidden} autre${hidden > 1 ? 's' : ''} à lire sur le panel web` : ''}`;
      container
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
      if (url) {
        container.addActionRowComponents(
          new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Changelog complet').setEmoji('📜').setURL(url)),
        );
      }
    }
    return container;
  });
}

module.exports = {
  // Annonce publique d'une mise à jour : réservée aux administrateurs (modifiable avec /permission).
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('changelog')
    .setDescription('Publier la liste des modifications d’une version du bot (la dernière par défaut)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('version').setDescription('Version à afficher (latest = la plus récente)').setAutocomplete(true).setMaxLength(20))
    .addBooleanOption((o) => o.setName('apercu').setDescription('Afficher seulement pour toi au lieu de publier dans le salon')),

  async autocomplete(core, interaction) {
    const typed = String(interaction.options.getFocused() ?? '').trim().toLowerCase();
    const entries = loadChangelog();
    const choices = [
      { name: `Dernière version${entries[0] ? ` (v${entries[0].version})` : ''}`, value: 'latest' },
      ...entries.map((entry) => ({ name: `v${entry.version}${entry.date ? ` — ${entry.date}` : ''}${entry.title ? ` · ${entry.title}` : ''}`.slice(0, 100), value: entry.version })),
    ];
    await interaction.respond(choices.filter((c) => !typed || c.name.toLowerCase().includes(typed) || c.value.toLowerCase().includes(typed)).slice(0, 25));
  },

  async execute(core, interaction) {
    const wanted = interaction.options.getString('version') ?? 'latest';
    const entry = findVersion(wanted);
    if (!entry) {
      const known = loadChangelog().map((e) => `v${e.version}`);
      await ui.replyError(interaction, known.length ? `Version inconnue : \`${wanted}\`. Disponibles : ${known.join(', ')}.` : 'Aucun changelog n’est disponible (changelog.json absent ou invalide).', 'Changelog', '📜');
      return;
    }

    const preview = interaction.options.getBoolean('apercu') ?? false;
    const url = webUrl(core.config, `changelog#v${entry.version}`);
    const flags = MessageFlags.IsComponentsV2 | (preview ? MessageFlags.Ephemeral : 0);
    const send = (container, index) =>
      (index === 0 ? interaction.reply.bind(interaction) : interaction.followUp.bind(interaction))({ components: [container], flags, allowedMentions: { parse: [] } });

    let messages = changelogMessages(core, entry, url);
    for (let index = 0; index < messages.length; index += 1) {
      try {
        await send(messages[index], index);
      } catch (err) {
        // Discord refuse un bouton lien vers une adresse locale (localhost…) : ce message part sans le bouton.
        if (!url || err?.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType || index !== messages.length - 1) throw err;
        messages = changelogMessages(core, entry, null);
        await send(messages[index], index);
      }
    }
  },
};
