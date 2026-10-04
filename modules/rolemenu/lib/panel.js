'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const ui = require('../../../src/bot/ui');
const { webBaseUrl } = require('../../../src/web/url');
const { parseParams } = require('./conditions');
const { parseEmoji } = require('./safety');
const { LIMITS, TYPE_LABEL, MODE_LABEL, optionName } = require('./message');

const IDLE_MS = 10 * 60_000;
const MODAL_MS = 5 * 60_000;
const MAX_SELECT_OPTIONS = 25;

const TYPES = [
  ['reaction', 'Réactions (emojis)', 'Un émoji par rôle sous le message'],
  ['button', 'Boutons', 'Un bouton par rôle'],
  ['select', 'Menu déroulant', 'Une liste dans laquelle choisir'],
];
const MODES = [
  ['multiple', 'Plusieurs rôles', 'Le membre cumule les rôles du menu'],
  ['single', 'Un seul rôle', 'Choisir un rôle retire les autres du menu'],
];
const STYLES = [
  ['secondary', 'Gris'],
  ['primary', 'Bleu'],
  ['success', 'Vert'],
  ['danger', 'Rouge'],
];
const label = (list, value) => list.find((item) => item[0] === value)?.[1] ?? value;

const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, text, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style);

function stringSelect(id, placeholder, options) {
  return new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options);
}

/** Liste d'items `[valeur, libellé, description?]` → options de menu, avec la valeur courante présélectionnée. */
function choices(list, current) {
  return list.map(([value, text, description]) => {
    const option = { label: text, value, default: value === current };
    if (description) option.description = description;
    return option;
  });
}

/** Mentions de rôle → noms (libellés de menus déroulants, où une mention s'afficherait en clair). */
function plain(guild, text) {
  return text.replace(/<@&(\d+)>/g, (match, id) => `@${guild.roles.cache.get(id)?.name ?? id}`);
}

/**
 * Panneau interactif de configuration de RôleMenu sur Discord (`/rolemenu`) : un seul message éphémère qui
 * change d'écran (accueil → menu → rôle → conditions…) avec des boutons, des sélecteurs de rôles / salons et des
 * fenêtres de saisie. Toutes les modifications passent par RoleMenuConfig, comme le panel web.
 */
class RoleMenuPanel {
  constructor({ ctx }) {
    this.ctx = ctx;
    this.logger = ctx.logger;
  }

  get service() {
    return this.ctx.services.rolemenu;
  }

  get config() {
    return this.ctx.services.config;
  }

  get conditions() {
    return this.ctx.services.conditions;
  }

  async open(interaction) {
    const guild = interaction.guild;
    const session = {
      guild,
      userId: interaction.user.id,
      actor: { id: interaction.user.id, name: interaction.user.username, web: false, member: interaction.member },
      state: { screen: 'home', notice: null, menuId: null, optionId: null, scope: 'menu', draft: { type: 'button', mode: 'multiple' }, pending: null },
    };
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await interaction.editReply(await this.render(session));

    const collector = message.createMessageComponentCollector({
      idle: IDLE_MS,
      filter: (i) => i.user.id === session.userId,
    });
    collector.on('collect', (i) => {
      this.dispatch(session, i, collector);
    });
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  }

  // ── Affichage ─────────────────────────────────────────────────────────────

  async render(session) {
    const state = session.state;
    const notice = state.notice;
    state.notice = null;
    let view;
    try {
      view = await this[`${state.screen}View`](session);
    } catch (err) {
      this.logger.error(`Écran « ${state.screen} » de RôleMenu impossible`, err);
      state.screen = 'home';
      view = await this.homeView(session);
    }
    if (view.redirect) {
      state.screen = view.redirect;
      state.notice = notice ?? view.notice ?? null;
      return this.render(session);
    }
    const description = [notice, view.card.description].filter(Boolean).join('\n\n');
    return { embeds: [ui.card({ ...view.card, description }).embed], components: view.components };
  }

  /** Répond à un composant ou à une fenêtre de saisie en réaffichant l'écran courant. */
  async respond(interaction, session) {
    const payload = await this.render(session);
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.update(payload);
  }

  /** Message de menu introuvable (supprimé depuis ailleurs) : retour à l'accueil. */
  gone(what) {
    return { redirect: 'home', notice: `❌ ${what} introuvable (supprimé depuis ailleurs ?).` };
  }

  async homeView(session) {
    const guild = session.guild;
    const [menus, settings] = await Promise.all([this.service.listMenus(guild.id), this.service.settings(guild.id)]);
    const lines = menus.length
      ? menus.map((m) => `**n°${m.id}** · ${m.name} — ${TYPE_LABEL[m.type]} · ${MODE_LABEL[m.mode]} · ${m.message_id ? '📌 publié' : '⚠️ non publié'}`)
      : ['*Aucun menu pour l’instant : crée-en un avec « Nouveau menu ».*'];
    const base = webBaseUrl(this.ctx.config);

    const rows = [];
    if (menus.length) {
      rows.push(
        row(
          stringSelect(
            'home:menu',
            'Configurer un menu…',
            menus.slice(0, MAX_SELECT_OPTIONS).map((m) => ({ label: m.name.slice(0, 100), value: String(m.id), description: `${TYPE_LABEL[m.type]} · ${MODE_LABEL[m.mode]}` })),
          ),
        ),
      );
    }
    const buttons = [
      button('home:new', '➕ Nouveau menu', ButtonStyle.Success),
      button('home:log', '📝 Journal'),
    ];
    if (base) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Panel web').setURL(`${base}/m/rolemenu/?guild=${guild.id}`));
    buttons.push(button('home:close', '✖ Fermer'));
    rows.push(row(...buttons));

    return {
      card: {
        title: '🎭 RôleMenu',
        description: 'Menus de rôles que les membres utilisent eux-mêmes (réactions, boutons ou menu déroulant), avec des conditions d’accès.',
        body: [
          { stats: [['Menus', menus.length], ['Publiés', menus.filter((m) => m.message_id).length]] },
          `\n${lines.join('\n')}`,
          menus.length > MAX_SELECT_OPTIONS ? `\n*Seuls les ${MAX_SELECT_OPTIONS} premiers menus sont sélectionnables ici : utilise le panel web pour les autres.*` : null,
          `\n📝 Journal : ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'aucun'}`,
        ],
      },
      components: rows,
    };
  }

  newMenuView(session) {
    const { draft } = session.state;
    return {
      card: {
        title: '➕ Nouveau menu',
        description: `Choisis le **type** et le **mode**, puis donne un nom au menu.\n\n**Type** : ${label(TYPES, draft.type)}\n**Mode** : ${label(MODES, draft.mode)}`,
      },
      components: [
        row(stringSelect('new:type', 'Type de menu', choices(TYPES, draft.type))),
        row(stringSelect('new:mode', 'Plusieurs rôles ou un seul', choices(MODES, draft.mode))),
        row(button('new:create', '✏️ Nommer et créer', ButtonStyle.Success), button('nav:home', '◀ Retour')),
      ],
    };
  }

  /** Charge le menu courant avec ses options et conditions ; null s'il a disparu. */
  async currentBundle(session) {
    const bundle = session.state.menuId ? await this.service.bundle(session.state.menuId) : null;
    return bundle && String(bundle.menu.guild_id) === session.guild.id ? bundle : null;
  }

  async menuView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const { menu, options, conditions } = bundle;
    const guild = session.guild;
    const link = menu.message_id && menu.channel_id ? `https://discord.com/channels/${guild.id}/${menu.channel_id}/${menu.message_id}` : null;

    const optionLines = options.map((option, index) => {
      const emoji = parseEmoji(option.emoji);
      const count = conditions.filter((c) => String(c.option_id) === String(option.id)).length;
      return `${index + 1}. ${emoji ? `${emoji.raw} ` : ''}<@&${option.role_id}>${option.label ? ` — ${option.label}` : ''}${count ? ` · 🔒 ${count}` : ''}`;
    });
    const general = conditions.filter((c) => c.option_id === null);

    const rows = [];
    if (options.length) {
      rows.push(
        row(
          stringSelect(
            'menu:option',
            'Modifier un rôle du menu…',
            options.slice(0, MAX_SELECT_OPTIONS).map((option) => {
              const item = { label: optionName(guild, option).slice(0, 100), value: String(option.id) };
              const emoji = parseEmoji(option.emoji);
              if (emoji) item.emoji = emoji.button;
              return item;
            }),
          ),
        ),
      );
    }
    rows.push(
      row(
        button('menu:add', '➕ Ajouter des rôles', ButtonStyle.Success),
        button('menu:settings', '⚙️ Réglages'),
        button('menu:message', '🎨 Message'),
        button('menu:conds', `🔒 Conditions${general.length ? ` (${general.length})` : ''}`),
      ),
      row(
        button('menu:publish', menu.message_id ? '🔄 Mettre à jour' : '📤 Publier', ButtonStyle.Primary),
        button('menu:delete', '🗑️ Supprimer', ButtonStyle.Danger),
        button('nav:home', '◀ Retour'),
      ),
    );

    return {
      card: {
        title: `🎭 ${menu.name}`,
        body: [
          {
            stats: [
              ['Menu', `n°${menu.id}`],
              ['Type', TYPE_LABEL[menu.type]],
              ['Mode', MODE_LABEL[menu.mode]],
              ['Maximum', menu.mode === 'single' ? '1' : menu.max_selected ? String(menu.max_selected) : 'illimité'],
              ['Retrait possible', menu.removable ? 'oui' : 'non'],
              ['Options', `${options.length}/${LIMITS[menu.type]}`],
            ],
          },
          link ? `📌 [Message publié](${link}) dans <#${menu.channel_id}>` : '⚠️ Pas encore publié.',
          `\n**Rôles du menu**\n${optionLines.length ? optionLines.join('\n') : '*Aucun : « Ajouter des rôles ».*'}`,
          general.length ? `\n**🔒 Conditions du menu** (toutes requises)\n${general.map((c) => `• ${this.conditions.summarize(c.type, parseParams(c.params))}`).join('\n')}` : null,
        ],
      },
      components: rows,
    };
  }

  async addRolesView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const reaction = bundle.menu.type === 'reaction';
    const select = new RoleSelectMenuBuilder().setCustomId('add:roles').setPlaceholder(reaction ? 'Choisis le rôle à ajouter…' : 'Choisis les rôles à ajouter…').setMinValues(1).setMaxValues(reaction ? 1 : 10);
    return {
      card: {
        title: `➕ Ajouter des rôles — ${bundle.menu.name}`,
        description: reaction
          ? 'Choisis **un rôle** : tu devras ensuite indiquer son **émoji** (obligatoire pour les réactions).'
          : 'Choisis jusqu’à **10 rôles** : ils sont ajoutés tout de suite (texte, émoji et couleur se modifient ensuite).\n\nLes rôles `@everyone`, d’intégration, au-dessus du bot, ou à permissions de gestion sont refusés.',
      },
      components: [row(select), row(button('nav:menu', '◀ Retour au menu'))],
    };
  }

  async optionView(session) {
    const bundle = await this.currentBundle(session);
    const option = bundle?.options.find((o) => String(o.id) === String(session.state.optionId));
    if (!option) return { redirect: 'menu', notice: '❌ Option introuvable.' };
    const { menu, conditions } = bundle;
    const own = conditions.filter((c) => String(c.option_id) === String(option.id));
    const emoji = parseEmoji(option.emoji);
    const position = bundle.options.findIndex((o) => String(o.id) === String(option.id)) + 1;

    const rows = [];
    if (menu.type === 'button') rows.push(row(stringSelect('opt:style', 'Couleur du bouton', choices(STYLES, option.style))));
    rows.push(
      row(
        button('opt:edit', '✏️ Modifier'),
        button('opt:up', '⬆'),
        button('opt:down', '⬇'),
        button('opt:conds', `🔒 Conditions${own.length ? ` (${own.length})` : ''}`),
        button('opt:remove', '🗑️ Retirer', ButtonStyle.Danger),
      ),
      row(button('nav:menu', '◀ Retour au menu')),
    );
    return {
      card: {
        title: `🏷️ ${optionName(session.guild, option)}`,
        description: `Menu **${menu.name}** · position ${position}/${bundle.options.length}`,
        body: [
          `🏷️ <@&${option.role_id}>`,
          emoji ? `🎨 Émoji : ${emoji.raw}` : null,
          option.description ? `📝 Description : ${option.description}` : null,
          menu.type === 'button' ? `🖌️ Couleur : ${label(STYLES, option.style)}` : null,
          own.length ? `\n**🔒 Conditions de ce rôle** (toutes requises, en plus de celles du menu)\n${own.map((c) => `• ${this.conditions.summarize(c.type, parseParams(c.params))}`).join('\n')}` : '\n*Aucune condition propre à ce rôle.*',
        ],
      },
      components: rows,
    };
  }

  async condsView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const { state } = session;
    const option = state.scope === 'option' ? bundle.options.find((o) => String(o.id) === String(state.optionId)) : null;
    if (state.scope === 'option' && !option) return { redirect: 'menu', notice: '❌ Option introuvable.' };
    const list = bundle.conditions.filter((c) => (option ? String(c.option_id) === String(option.id) : c.option_id === null));
    const types = this.conditions.list();

    const rows = [];
    if (list.length) {
      rows.push(
        row(
          stringSelect(
            'cond:remove',
            'Retirer une condition…',
            list.slice(0, MAX_SELECT_OPTIONS).map((c) => ({ label: plain(session.guild, this.conditions.summarize(c.type, parseParams(c.params))).slice(0, 100), value: String(c.id) })),
          ),
        ),
      );
    }
    rows.push(
      row(stringSelect('cond:add', 'Ajouter une condition…', types.slice(0, MAX_SELECT_OPTIONS).map((t) => ({ label: t.label.slice(0, 100), value: t.type, description: t.description.slice(0, 100) || undefined })))),
      row(button('nav:back', option ? '◀ Retour au rôle' : '◀ Retour au menu')),
    );
    return {
      card: {
        title: `🔒 Conditions — ${option ? optionName(session.guild, option) : bundle.menu.name}`,
        description: option
          ? 'Conditions propres à **ce rôle**. Elles **se cumulent** : toutes doivent être remplies, en plus de celles du menu.'
          : 'Conditions de **tout le menu**. Elles **se cumulent** : toutes doivent être remplies pour obtenir n’importe quel rôle du menu (et s’ajoutent à celles de chaque rôle).',
        body: [
          list.length ? `**Actuellement (${list.length})**\n${list.map((c) => `• ${this.conditions.summarize(c.type, parseParams(c.params))}${this.conditions.has(c.type) ? '' : ' ⚠️ *type indisponible : bloque l’accès*'}`).join('\n')}` : '*Aucune condition : tout le monde peut prendre ' + (option ? 'ce rôle.*' : 'les rôles du menu.*'),
          '\nAjoute-en autant que nécessaire, de types identiques ou différents ; pour un « ou » entre rôles, utilise « Avoir au moins un de ces rôles ».',
        ],
      },
      components: rows,
    };
  }

  /** Saisie d'un paramètre de la condition en cours de création (sélecteur de rôles ou bouton de saisie d'un nombre). */
  condParamView(session) {
    const pending = session.state.pending;
    const spec = pending?.specs[pending.index];
    if (!spec) return { redirect: 'conds' };
    const definition = this.conditions.list().find((t) => t.type === pending.type);
    const rows = [];
    if (spec.kind === 'roles') {
      rows.push(row(new RoleSelectMenuBuilder().setCustomId('cond:roles').setPlaceholder(spec.label).setMinValues(1).setMaxValues(10)));
    } else {
      rows.push(row(button('cond:num', `✏️ Saisir : ${spec.label}`.slice(0, 80), ButtonStyle.Primary)));
    }
    rows.push(row(button('cond:cancel', '✖ Annuler')));
    return {
      card: {
        title: `🔒 Nouvelle condition — ${definition?.label ?? pending.type}`,
        description: `Étape ${pending.index + 1}/${pending.specs.length} : **${spec.label}**${spec.kind === 'roles' ? ' (jusqu’à 10 rôles)' : ''}.`,
      },
      components: rows,
    };
  }

  async settingsView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const { menu, options } = bundle;
    return {
      card: {
        title: `⚙️ Réglages — ${menu.name}`,
        body: [
          {
            stats: [
              ['Type', TYPE_LABEL[menu.type]],
              ['Mode', MODE_LABEL[menu.mode]],
              ['Maximum', menu.mode === 'single' ? '1' : menu.max_selected ? String(menu.max_selected) : 'illimité'],
              ['Retrait possible', menu.removable ? 'oui' : 'non'],
            ],
          },
          `\n**Plusieurs rôles** : le membre cumule les rôles du menu (jusqu’au maximum). **Un seul rôle** : choisir un rôle retire les autres rôles du menu.`,
          options.length ? null : '\n*Ajoute des rôles avant de publier.*',
        ],
      },
      components: [
        row(stringSelect('set:type', 'Type de menu', choices(TYPES, menu.type))),
        row(stringSelect('set:mode', 'Plusieurs rôles ou un seul', choices(MODES, menu.mode))),
        row(
          button('set:text', '✏️ Nom, maximum…'),
          button('set:removable', menu.removable ? '✅ Retrait autorisé' : '⛔ Retrait interdit'),
          button('nav:menu', '◀ Retour au menu'),
        ),
      ],
    };
  }

  async messageView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const { menu } = bundle;
    const custom = menu.embed_title || menu.embed_description;
    return {
      card: {
        title: `🎨 Message — ${menu.name}`,
        description: custom
          ? 'Message personnalisé :'
          : 'Aucun texte personnalisé : le bot génère le message avec la liste des rôles. Personnalise-le pour écrire ton propre texte.',
        body: [
          menu.embed_title ? `**Titre** : ${menu.embed_title}` : null,
          menu.embed_description ? `**Texte** : ${menu.embed_description.slice(0, 600)}` : null,
          menu.embed_color ? `**Couleur** : ${menu.embed_color}` : null,
          menu.embed_footer ? `**Pied de page** : ${menu.embed_footer}` : null,
          menu.embed_image ? `**Image** : ${menu.embed_image}` : null,
          menu.embed_thumbnail ? `**Vignette** : ${menu.embed_thumbnail}` : null,
        ],
      },
      components: [
        row(
          button('msg:edit', '✏️ Titre, texte, couleur…', ButtonStyle.Primary),
          button('msg:thumb', '🖼️ Vignette'),
          button('msg:reset', '♻️ Message automatique'),
        ),
        row(button('nav:menu', '◀ Retour au menu')),
      ],
    };
  }

  async publishView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('pub:channel')
      .setPlaceholder('Choisis le salon du menu…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    if (bundle.menu.channel_id && session.guild.channels.cache.has(String(bundle.menu.channel_id))) select.setDefaultChannels(String(bundle.menu.channel_id));
    return {
      card: {
        title: `📤 Publier — ${bundle.menu.name}`,
        description: bundle.menu.message_id
          ? 'Le menu est déjà publié. Choisis le **même salon** pour mettre à jour le message, ou un autre pour le déplacer.'
          : 'Choisis le salon où publier le menu.',
      },
      components: [row(select), row(button('nav:menu', '◀ Retour au menu'))],
    };
  }

  async confirmDeleteView(session) {
    const bundle = await this.currentBundle(session);
    if (!bundle) return this.gone('Menu');
    return {
      card: { title: '🗑️ Supprimer le menu ?', description: `Le menu **${bundle.menu.name}** (n°${bundle.menu.id}), ses rôles, ses conditions et son message publié seront supprimés.` },
      components: [row(button('del:yes', 'Supprimer définitivement', ButtonStyle.Danger), button('nav:menu', 'Annuler'))],
    };
  }

  async journalView(session) {
    const settings = await this.service.settings(session.guild.id);
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('log:channel')
      .setPlaceholder('Choisis le salon de journal…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    if (settings.logChannelId && session.guild.channels.cache.has(String(settings.logChannelId))) select.setDefaultChannels(String(settings.logChannelId));
    return {
      card: {
        title: '📝 Journal',
        description: `Chaque modification de la configuration (commande ou panel web) y est publiée.\n\nSalon actuel : ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'aucun'}`,
      },
      components: [row(select), row(button('log:clear', 'Retirer le journal'), button('nav:home', '◀ Retour'))],
    };
  }

  // ── Interactions ──────────────────────────────────────────────────────────

  async dispatch(session, interaction, collector) {
    try {
      await this.handle(session, interaction, collector);
    } catch (err) {
      this.logger.error(`Interaction du panneau RôleMenu (${interaction.customId})`, err);
      session.state.notice = `❌ ${String(err.message ?? 'Erreur inattendue.').slice(0, 300)}`;
      await this.respond(interaction, session).catch(() => {});
    }
  }

  /** Ouvre une fenêtre de saisie ; renvoie { submit, values } ou null si elle est fermée sans validation. */
  async askModal(session, interaction, title, fields) {
    const customId = `arp:${interaction.id}`;
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
    for (const field of fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label.slice(0, 45))
        .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(Boolean(field.required));
      if (field.max) input.setMaxLength(field.max);
      if (field.value) input.setValue(String(field.value).slice(0, field.max ?? 4000));
      if (field.placeholder) input.setPlaceholder(field.placeholder.slice(0, 100));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    await interaction.showModal(modal);
    const submit = await interaction
      .awaitModalSubmit({ time: MODAL_MS, filter: (m) => m.customId === customId && m.user.id === session.userId })
      .catch(() => null);
    if (!submit) return null;
    const values = {};
    for (const field of fields) values[field.id] = submit.fields.getTextInputValue(field.id);
    return { submit, values };
  }

  /** Résume un résultat de RoleMenuConfig en notice (✅ / ❌) et affiche les avertissements éventuels. */
  notice(session, result, success) {
    session.state.notice = result.error ? `❌ ${result.error}` : [`✅ ${success}`, ...(result.warnings ?? []).map((w) => `⚠️ ${w}`)].join('\n');
    return !result.error;
  }

  async handle(session, i, collector) {
    const { state, guild, actor } = session;
    const [group, action] = i.customId.split(':');
    const id = i.customId;
    const value = i.isAnySelectMenu?.() ? i.values[0] : null;

    // ── Navigation ──
    if (group === 'nav') {
      state.screen = action === 'back' ? (state.scope === 'option' ? 'option' : 'menu') : action;
      return this.respond(i, session);
    }
    if (id === 'home:close') {
      collector.stop();
      return i.update({ embeds: [ui.card({ description: '✖ Panneau fermé.' }).embed], components: [] });
    }

    // ── Accueil ──
    if (id === 'home:menu') {
      state.menuId = value;
      state.screen = 'menu';
      return this.respond(i, session);
    }
    if (id === 'home:new') {
      state.draft = { type: 'button', mode: 'multiple' };
      state.screen = 'newMenu';
      return this.respond(i, session);
    }
    if (id === 'home:log') {
      state.screen = 'journal';
      return this.respond(i, session);
    }

    // ── Nouveau menu ──
    if (id === 'new:type' || id === 'new:mode') {
      state.draft[id === 'new:type' ? 'type' : 'mode'] = value;
      return this.respond(i, session);
    }
    if (id === 'new:create') {
      const modal = await this.askModal(session, i, 'Nouveau menu', [
        { id: 'name', label: 'Nom du menu', required: true, max: 100, placeholder: 'Ex : Rôles de notifications' },
        { id: 'max', label: 'Maximum de rôles (0 = illimité)', max: 2, value: '0' },
      ]);
      if (!modal) return;
      const result = await this.config.createMenu(guild, actor, { name: modal.values.name, type: state.draft.type, mode: state.draft.mode, maxSelected: modal.values.max });
      if (result.error) state.notice = `❌ ${result.error}`;
      else {
        state.menuId = String(result.menu.id);
        state.screen = 'menu';
        state.notice = `✅ Menu **${result.menu.name}** créé. Ajoute des rôles, puis publie-le.`;
      }
      return this.respond(modal.submit, session);
    }

    // ── Menu ──
    if (id === 'menu:option') {
      state.optionId = value;
      state.screen = 'option';
      return this.respond(i, session);
    }
    if (id === 'menu:add') {
      state.screen = 'addRoles';
      return this.respond(i, session);
    }
    if (id === 'menu:settings' || id === 'menu:message' || id === 'menu:publish') {
      state.screen = { 'menu:settings': 'settings', 'menu:message': 'message', 'menu:publish': 'publish' }[id];
      return this.respond(i, session);
    }
    if (id === 'menu:conds') {
      state.scope = 'menu';
      state.screen = 'conds';
      return this.respond(i, session);
    }
    if (id === 'menu:delete') {
      state.screen = 'confirmDelete';
      return this.respond(i, session);
    }
    if (id === 'del:yes') {
      const result = await this.config.deleteMenu(guild, actor, state.menuId);
      state.screen = 'home';
      this.notice(session, result, 'Menu supprimé.');
      return this.respond(i, session);
    }

    // ── Ajout de rôles ──
    if (id === 'add:roles') {
      const bundle = await this.currentBundle(session);
      if (!bundle) return this.respond(i, session);
      if (bundle.menu.type === 'reaction') {
        const modal = await this.askModal(session, i, 'Émoji du rôle', [
          { id: 'emoji', label: 'Émoji (😀 ou <:nom:id>)', required: true, max: 80 },
          { id: 'label', label: 'Texte affiché (facultatif)', max: 80 },
        ]);
        if (!modal) return;
        const result = await this.config.addOption(guild, actor, state.menuId, { roleId: i.values[0], emoji: modal.values.emoji, label: modal.values.label });
        if (this.notice(session, result, 'Rôle ajouté au menu.')) state.screen = 'menu';
        return this.respond(modal.submit, session);
      }
      await i.deferUpdate();
      const lines = [];
      let added = 0;
      for (const roleId of i.values) {
        const result = await this.config.addOption(guild, actor, state.menuId, { roleId });
        if (result.error) lines.push(`❌ <@&${roleId}> : ${result.error}`);
        else added += 1;
      }
      state.screen = 'menu';
      state.notice = [added ? `✅ ${added} rôle(s) ajouté(s).` : null, ...lines].filter(Boolean).join('\n');
      return this.respond(i, session);
    }

    // ── Option ──
    if (id === 'opt:style') {
      const result = await this.config.updateOption(guild, actor, state.optionId, { style: value });
      this.notice(session, result, 'Couleur modifiée.');
      return this.respond(i, session);
    }
    if (id === 'opt:edit') {
      const bundle = await this.currentBundle(session);
      const option = bundle?.options.find((o) => String(o.id) === String(state.optionId));
      if (!option) return this.respond(i, session);
      const fields = [
        { id: 'label', label: 'Texte affiché', max: 80, value: option.label, placeholder: 'Par défaut : nom du rôle' },
        { id: 'emoji', label: 'Émoji', max: 80, value: option.emoji, required: bundle.menu.type === 'reaction' },
      ];
      if (bundle.menu.type === 'select') fields.push({ id: 'description', label: 'Description (sous le texte)', max: 100, value: option.description });
      const modal = await this.askModal(session, i, 'Modifier le rôle', fields);
      if (!modal) return;
      const input = { label: modal.values.label, emoji: modal.values.emoji };
      if ('description' in modal.values) input.description = modal.values.description;
      this.notice(session, await this.config.updateOption(guild, actor, state.optionId, input), 'Rôle modifié.');
      return this.respond(modal.submit, session);
    }
    if (id === 'opt:up' || id === 'opt:down') {
      await this.config.moveOption(guild, actor, state.optionId, id === 'opt:up' ? -1 : 1);
      return this.respond(i, session);
    }
    if (id === 'opt:conds') {
      state.scope = 'option';
      state.screen = 'conds';
      return this.respond(i, session);
    }
    if (id === 'opt:remove') {
      const result = await this.config.removeOption(guild, actor, state.optionId);
      state.screen = 'menu';
      this.notice(session, result, 'Rôle retiré du menu.');
      return this.respond(i, session);
    }

    // ── Conditions ──
    if (id === 'cond:remove') {
      this.notice(session, await this.config.removeCondition(guild, actor, value), 'Condition retirée.');
      return this.respond(i, session);
    }
    if (id === 'cond:add') {
      const definition = this.conditions.list().find((t) => t.type === value);
      if (!definition) {
        state.notice = '❌ Type de condition inconnu.';
        return this.respond(i, session);
      }
      state.pending = { type: value, specs: definition.params, index: 0, params: {} };
      return this.advanceCondition(session, i);
    }
    if (id === 'cond:cancel') {
      state.pending = null;
      state.screen = 'conds';
      return this.respond(i, session);
    }
    if (id === 'cond:roles' || id === 'cond:num') {
      const pending = state.pending;
      const spec = pending?.specs[pending.index];
      if (!spec) return this.respond(i, session);
      if (id === 'cond:roles') {
        pending.params[spec.key] = i.values;
        pending.index += 1;
        return this.advanceCondition(session, i);
      }
      const modal = await this.askModal(session, i, 'Nouvelle condition', [{ id: 'value', label: spec.label, required: true, max: 8 }]);
      if (!modal) return;
      pending.params[spec.key] = modal.values.value.trim();
      pending.index += 1;
      return this.advanceCondition(session, modal.submit);
    }

    // ── Réglages du menu ──
    if (id === 'set:type' || id === 'set:mode') {
      this.notice(session, await this.config.updateMenu(guild, actor, state.menuId, { [id === 'set:type' ? 'type' : 'mode']: value }), 'Réglage enregistré.');
      return this.respond(i, session);
    }
    if (id === 'set:removable') {
      const bundle = await this.currentBundle(session);
      if (bundle) this.notice(session, await this.config.updateMenu(guild, actor, state.menuId, { removable: !bundle.menu.removable }), 'Réglage enregistré.');
      return this.respond(i, session);
    }
    if (id === 'set:text') {
      const bundle = await this.currentBundle(session);
      if (!bundle) return this.respond(i, session);
      const fields = [
        { id: 'name', label: 'Nom du menu', required: true, max: 100, value: bundle.menu.name },
        { id: 'max', label: 'Maximum de rôles (0 = illimité)', max: 2, value: String(bundle.menu.max_selected || 0) },
      ];
      if (bundle.menu.type === 'select') fields.push({ id: 'placeholder', label: 'Texte du menu déroulant', max: 150, value: bundle.menu.placeholder });
      const modal = await this.askModal(session, i, 'Réglages du menu', fields);
      if (!modal) return;
      const input = { name: modal.values.name, maxSelected: modal.values.max };
      if ('placeholder' in modal.values) input.placeholder = modal.values.placeholder;
      this.notice(session, await this.config.updateMenu(guild, actor, state.menuId, input), 'Réglages enregistrés.');
      return this.respond(modal.submit, session);
    }

    // ── Message du menu ──
    if (id === 'msg:edit') {
      const bundle = await this.currentBundle(session);
      if (!bundle) return this.respond(i, session);
      const { menu } = bundle;
      const modal = await this.askModal(session, i, 'Message du menu', [
        { id: 'title', label: 'Titre', max: 256, value: menu.embed_title },
        { id: 'description', label: 'Texte', paragraph: true, max: 4000, value: menu.embed_description },
        { id: 'color', label: 'Couleur (#RRGGBB)', max: 7, value: menu.embed_color },
        { id: 'footer', label: 'Pied de page', max: 2048, value: menu.embed_footer },
        { id: 'image', label: 'Image (lien)', max: 512, value: menu.embed_image },
      ]);
      if (!modal) return;
      const v = modal.values;
      const result = await this.config.updateMenu(guild, actor, state.menuId, { embedTitle: v.title, embedDescription: v.description, embedColor: v.color, embedFooter: v.footer, embedImage: v.image });
      this.notice(session, result, 'Message enregistré.');
      return this.respond(modal.submit, session);
    }
    if (id === 'msg:thumb') {
      const bundle = await this.currentBundle(session);
      if (!bundle) return this.respond(i, session);
      const modal = await this.askModal(session, i, 'Vignette du menu', [{ id: 'url', label: 'Lien de la vignette (vide = aucune)', max: 512, value: bundle.menu.embed_thumbnail }]);
      if (!modal) return;
      this.notice(session, await this.config.updateMenu(guild, actor, state.menuId, { embedThumbnail: modal.values.url }), 'Vignette enregistrée.');
      return this.respond(modal.submit, session);
    }
    if (id === 'msg:reset') {
      const blank = { embedTitle: null, embedDescription: null, embedColor: null, embedFooter: null, embedImage: null, embedThumbnail: null };
      this.notice(session, await this.config.updateMenu(guild, actor, state.menuId, blank), 'Message automatique rétabli.');
      return this.respond(i, session);
    }

    // ── Publication ──
    if (id === 'pub:channel') {
      await i.deferUpdate(); // la publication (réactions comprises) peut durer quelques secondes
      const result = await this.config.publish(guild, actor, state.menuId, guild.channels.cache.get(value));
      state.screen = 'menu';
      this.notice(session, result, `Menu publié dans <#${value}>.`);
      return this.respond(i, session);
    }

    // ── Journal ──
    if (id === 'log:channel' || id === 'log:clear') {
      const result = await this.config.setLogChannel(guild, actor, id === 'log:clear' ? null : value);
      this.notice(session, result, id === 'log:clear' ? 'Journal désactivé.' : `Journal : <#${value}>.`);
      return this.respond(i, session);
    }
  }

  /** Passe au paramètre suivant de la condition en cours ; une fois tous saisis, l'enregistre. */
  async advanceCondition(session, interaction) {
    const { state, guild, actor } = session;
    const pending = state.pending;
    if (pending.index < pending.specs.length) {
      state.screen = 'condParam';
      return this.respond(interaction, session);
    }
    state.pending = null;
    state.screen = 'conds';
    const optionId = state.scope === 'option' ? state.optionId : null;
    const result = await this.config.addCondition(guild, actor, state.menuId, optionId, pending.type, pending.params);
    this.notice(session, result, `Condition ajoutée : ${result.condition ? this.conditions.summarize(pending.type, parseParams(result.condition.params)) : ''}`);
    return this.respond(interaction, session);
  }
}

module.exports = { RoleMenuPanel };
