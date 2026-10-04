'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { WEB_CATEGORIES, categoryLabel, rightLabel, categoryChoices, rightChoices } = require('../lib/webRights');
const { explainAccess, explanationText, SOURCE_TEXT } = require('../lib/check');
const { wildcardModule } = require('../lib/service');
const { parseDuration, formatDuration } = require('../../../src/core/duration');

const E = ui.EMOJIS;
const MAX_GRANT_SECONDS = 365 * 86_400;

/** « `/ban` » ou, pour un accord temporaire, « `/ban` ⏳ dans 2 heures ». */
function commandList(names, expiring = {}) {
  const label = (name) => (wildcardModule(name) ? `\`${name}\` (toutes les commandes)` : `\`/${name}\``);
  return names.length ? names.map((name) => `${label(name)}${expiring[name] ? ` ⏳ ${ui.ts(expiring[name], 'R')}` : ''}`).join(', ') : '—';
}

/** Option `duree` des accords : { expiresAt } (null = permanent) ou { error }. */
function grantExpiry(interaction) {
  const raw = interaction.options.getString('duree');
  if (!raw) return { expiresAt: null };
  const seconds = parseDuration(raw);
  if (!seconds || seconds > MAX_GRANT_SECONDS) return { error: 'Durée invalide : par exemple `2h`, `3j` ou `2sem` (1 an maximum).' };
  return { expiresAt: new Date(Date.now() + seconds * 1000), seconds };
}

function durationOption(option) {
  return option.setName('duree').setDescription('Accord temporaire : 2h, 3j, 2sem… (vide = permanent)').setMaxLength(20);
}

/** Droit du panel encore proposé par le catalogue (un modèle peut contenir une catégorie disparue). */
function validWebRight(category, right) {
  return Boolean(WEB_CATEGORIES[category]) && (right === '' || Boolean(WEB_CATEGORIES[category].rights[right]));
}

/**
 * Commandes regroupées par module (la « catégorie » d'une commande), un module par ligne, commandes séparées par
 * une virgule : « **Modération** : `/ban`, `/kick` ». `icon` précède chaque ligne (✅ autorisé / ⛔ bloqué).
 */
function commandLinesByModule(ctx, names, icon, expiring = {}) {
  const groups = new Map();
  for (const name of names) {
    const moduleName = wildcardModule(name) ?? ctx.commands.commands.get(name)?.module ?? 'core';
    const label = moduleName === 'core' ? 'Général' : ctx.modules.labelOf(moduleName);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(name);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => `${icon} **${label}** : ${commandList(list, expiring)}`);
}

function roleMention(guildId, roleId) {
  return roleId === guildId ? '@everyone' : `<@&${roleId}>`;
}

function commandOption(option) {
  return option.setName('command').setDescription('Commande(s) concernée(s), séparées par une virgule').setRequired(true).setAutocomplete(true);
}

/** Découpe une saisie « a, b c;d » en éléments uniques (les « / » de tête sont ignorés). */
function splitList(raw) {
  const items = String(raw ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().replace(/^\//, '').toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}

/** Modules qui ont au moins une commande gérable (cibles possibles d'un joker « module.* »). */
function manageableModules(ctx) {
  return [...new Set(ctx.commands.manageableCommands().map((command) => command.module))];
}

/**
 * Nom de commande valide et gérable (les commandes réservées aux propriétaires du bot sont exclues), ou joker
 * « module.* » = toutes les commandes de ce module, y compris celles ajoutées plus tard.
 */
function resolveCommand(ctx, raw) {
  const name = String(raw ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase();
  const module = wildcardModule(name);
  if (module) return manageableModules(ctx).includes(module) ? name : null;
  const command = ctx.commands.commands.get(name);
  return command && !command.ownerOnly ? name : null;
}

/** Plusieurs commandes d'un coup : renvoie { commands } ou { unknown } (noms non reconnus). */
function resolveCommands(ctx, raw) {
  const names = splitList(raw);
  if (!names.length) return { unknown: [] };
  const commands = [];
  const unknown = [];
  for (const name of names) {
    const found = resolveCommand(ctx, name);
    if (found) commands.push(found);
    else unknown.push(name);
  }
  return unknown.length ? { unknown } : { commands };
}

/** Rôles (role, role2…role5) ou utilisateurs (user, user2…user5) renseignés, sans doublon. */
function collectTargets(interaction, kind) {
  const base = kind === 'role' ? 'role' : 'user';
  const found = new Map();
  for (const key of [base, ...[2, 3, 4, 5].map((n) => `${base}${n}`)]) {
    const value = kind === 'role' ? interaction.options.getRole(key) : interaction.options.getUser(key);
    if (value) found.set(value.id, value);
  }
  return [...found.values()];
}

const MAX_TARGETS = 5;

function addExtraTargets(sub, kind) {
  for (let n = 2; n <= MAX_TARGETS; n += 1) {
    const name = `${kind === 'role' ? 'role' : 'user'}${n}`;
    if (kind === 'role') sub.addRoleOption((o) => o.setName(name).setDescription('Autre rôle concerné (facultatif)'));
    else sub.addUserOption((o) => o.setName(name).setDescription('Autre utilisateur concerné (facultatif)'));
  }
  return sub;
}

async function setRule(ctx, interaction, kind, allowed) {
  const { permissions } = ctx.services;
  const { commands, unknown } = resolveCommands(ctx, interaction.options.getString('command', true));
  if (!commands) {
    await ui.replyError(
      interaction,
      unknown.length ? `Commande(s) inconnue(s) : ${unknown.map((n) => `\`${n}\``).join(', ')} — choisissez-les dans la liste proposée.` : 'Aucune commande indiquée.',
    );
    return;
  }

  const { expiresAt, seconds, error } = allowed ? grantExpiry(interaction) : { expiresAt: null };
  if (error) {
    await ui.replyError(interaction, error, 'Durée invalide', '⏳');
    return;
  }

  const targets = collectTargets(interaction, kind);
  const mentionOf = (target) => (kind === 'role' ? (target.id === interaction.guildId ? '**@everyone**' : `<@&${target.id}>`) : `<@${target.id}>`);

  let changed = 0;
  let unchanged = 0;
  for (const target of targets) {
    for (const command of commands) {
      const previous = await permissions.setRule(kind, interaction.guildId, target.id, command, allowed, interaction.user.id, expiresAt);
      if (previous === allowed && !expiresAt) unchanged += 1;
      else changed += 1;
    }
  }

  const who = targets.map(mentionOf).join(', ');
  const what = commands.map((c) => `**/${c}**`).join(', ');
  let description = allowed ? `${who} : peut maintenant utiliser ${what}.` : `${who} : ne peut plus utiliser ${what}.`;
  if (expiresAt) {
    description += `\n⏳ Accord temporaire (${formatDuration(seconds)}) : retiré automatiquement ${ui.ts(expiresAt, 'R')}. Une autorisation permanente déjà en place est conservée.`;
  }
  if (kind === 'role' && !allowed) {
    description += '\n*Sauf pour les membres qui ont une règle individuelle ou un autre rôle autorisé.*';
  }

  const card = ui.successCard(allowed ? 'Permissions accordées' : 'Permissions retirées', description, E.permissions, [
    {
      stats: [
        [kind === 'role' ? 'Rôles' : 'Utilisateurs', targets.length],
        ['Commandes', commands.length],
        ['Règles modifiées', changed],
        ['Déjà en place', unchanged],
      ],
    },
  ]);
  await ui.respond(interaction, card, { ephemeral: true });
}
async function togglePublic(ctx, interaction) {
  const resolved = resolveCommands(ctx, interaction.options.getString('command', true));
  if (!resolved.commands) {
    const { unknown } = resolved;
    await ui.replyError(interaction, unknown.length ? `Commande(s) inconnue(s) : ${unknown.map((n) => `\`${n}\``).join(', ')}.` : 'Aucune commande indiquée.');
    return;
  }
  // Un joker « module.* » rend publiques (ou non) chacune des commandes actuelles du module.
  const commands = [
    ...new Set(
      resolved.commands.flatMap((name) => {
        const module = wildcardModule(name);
        return module ? ctx.commands.manageableCommands().filter((c) => c.module === module).map((c) => c.data.name) : [name];
      }),
    ),
  ];
  if (commands.length > 1) {
    const lines = [];
    for (const name of commands) {
      const nowPublic = await ctx.services.permissions.togglePublic(interaction.guildId, name, interaction.user.id);
      lines.push(`${nowPublic ? '🌍 Publique' : '🔒 Non publique'} : **/${name}**`);
    }
    await ui.respond(interaction, ui.successCard('Commandes publiques mises à jour', lines.join('\n'), E.permissions), { ephemeral: true });
    return;
  }
  const command = commands[0];
  const isPublic = await ctx.services.permissions.togglePublic(interaction.guildId, command, interaction.user.id);
  const card = ui.successCard(
    isPublic ? 'Commande publique' : 'Commande non publique',
    isPublic
      ? `**/${command}** est maintenant accessible à tous les membres, sauf exclusion individuelle ou de rôle.`
      : `**/${command}** n’est plus publique : l’accès par défaut s’applique de nouveau.`,
    E.permissions,
    [
      {
        stats: [
          ['Commande', `/${command}`],
          ['Avant', isPublic ? 'Non publique' : 'Publique'],
          ['Après', isPublic ? 'Publique' : 'Non publique'],
        ],
      },
    ],
  );
  await ui.respond(interaction, card, { ephemeral: true });
}

async function listRules(ctx, interaction) {
  const { permissions } = ctx.services;
  const { guildId } = interaction;
  const kind = interaction.options.getString('type', true) === 'rank' ? 'role' : 'user';
  const option = interaction.options.get('id');
  const [targets, publics] = await Promise.all([permissions.listByTarget(guildId, kind), permissions.publicCommands(guildId)]);
  const mention = (id) => (kind === 'role' ? roleMention(guildId, id) : `<@${id}>`);

  // Détail pour un rôle ou un utilisateur précis
  if (option) {
    const targetId = kind === 'role' ? option.role?.id : option.user?.id;
    if (!targetId) {
      await ui.replyError(
        interaction,
        kind === 'role' ? 'Avec le type « rank », mentionnez un rôle.' : 'Avec le type « user », mentionnez un utilisateur.',
      );
      return;
    }
    const entry = targets.get(targetId) ?? { allowed: [], denied: [] };
    const empty = !entry.allowed.length && !entry.denied.length;
    const card = ui.card({
      title: `Voici les permissions ${kind === 'role' ? 'du rôle' : 'de l’utilisateur'}.`,
      body: [
        { stats: [['Autorisées', entry.allowed.length], ['Bloquées', entry.denied.length]] },
        `${kind === 'role' ? '🏷️' : E.user} ${mention(targetId)}`,
        ...commandLinesByModule(ctx, entry.allowed, E.allowed, entry.expiring),
        ...commandLinesByModule(ctx, entry.denied, E.denied, entry.expiring),
        empty ? '\nAucune permission spécifique : les règles de rôle, publiques ou par défaut s’appliquent.' : null,
      ],
    });
    await ui.respond(interaction, card, { ephemeral: true });
    return;
  }

  // Vue globale : un élément par rôle / utilisateur
  const entries = [...targets];
  const label = kind === 'role' ? 'Rôle' : 'Utilisateur';
  const pages = ui.paginateLines(entries, {
    perPage: 5,
    build: (chunk, offset) =>
      ui.card({
        title: `Voici la liste des permissions ${kind === 'role' ? 'des rôles' : 'des utilisateurs'} du serveur. (${entries.length})`,
        body: [
          { stats: [['Total', entries.length], ['Commandes publiques', publics.length ? publics.map((p) => `/${p}`).join(', ') : 'aucune']] },
          ...chunk.map(([id, entry], i) => ({
            item: {
              emoji: E.permissions,
              title: `${label} n°${offset + i + 1}`,
              lines: [
                `${kind === 'role' ? '🏷️' : E.user} ${mention(id)}`,
                ...commandLinesByModule(ctx, entry.allowed, E.allowed, entry.expiring),
                ...commandLinesByModule(ctx, entry.denied, E.denied, entry.expiring),
              ],
            },
          })),
          chunk.length ? null : 'Aucune permission spécifique n’est définie.',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

async function purge(ctx, interaction) {
  const confirmed = await ui.confirm(interaction, {
    prompt: ui.card({
      title: 'Supprimer toutes les permissions ?',
      description:
        `${E.warning} Toutes les règles de rôles et d’utilisateurs, les commandes publiques et les accès au panel web de ce serveur ` +
        'seront **définitivement effacés**. Les accès reviendront aux valeurs par défaut.',
    }),
    confirmLabel: 'Tout supprimer',
  });

  if (!confirmed) {
    await ui.respond(interaction, ui.card({ description: `${E.error} Opération annulée : aucune permission n’a été supprimée.` }));
    return;
  }

  const counts = await ctx.services.permissions.purge(interaction.guildId);
  await ui.respond(
    interaction,
    ui.successCard('Permissions supprimées', 'Toutes les permissions personnalisées du serveur ont été effacées.', E.permissions, [
      {
        stats: [
          ['Règles de rôles', counts.permissions_roles],
          ['Règles d’utilisateurs', counts.permissions_users],
          ['Commandes publiques', counts.permissions_public],
          ['Accès au panel web', counts.web_permission_grants],
        ],
      },
    ]),
  );
}

// ── Accès au panel web (/permission grant-panel, revoke-panel, list-panel) ────────────────────
// Système distinct de /permission grant/revoke : celui-ci contrôle les commandes Discord, celui-ci
// contrôle ce qu'un rôle peut voir/faire sur le panel web (AUTHORIZED_WEB_USERS reste la porte
// d'entrée du dashboard ; ceci n'est qu'une restriction supplémentaire, jamais une porte à lui seul).

async function setWebGrant(ctx, interaction, granting) {
  const role = interaction.options.getRole('role', true);
  const category = interaction.options.getString('categorie');
  const rightsRaw = interaction.options.getString('droit');
  const categoryList = splitList(category);
  const rightList = splitList(rightsRaw);

  if (rightList.length && !categoryList.length) {
    return ui.replyError(interaction, 'Précise une catégorie pour cibler un droit particulier (sinon laisse aussi le droit vide).');
  }
  const categories = categoryList.length ? categoryList : Object.keys(WEB_CATEGORIES);
  for (const cat of categories) {
    if (!WEB_CATEGORIES[cat]) return ui.replyError(interaction, `Catégorie inconnue : \`${cat}\` — choisis-la dans la liste proposée.`);
  }
  // Chaque droit doit exister dans au moins une des catégories choisies ; il n'est appliqué qu'aux catégories qui le connaissent.
  for (const right of rightList) {
    if (!categories.some((cat) => WEB_CATEGORIES[cat].rights[right])) {
      return ui.replyError(interaction, `Droit inconnu : \`${right}\` (aucune des catégories choisies ne le propose) — choisis-le dans la liste proposée.`);
    }
  }

  const { expiresAt, seconds, error } = granting ? grantExpiry(interaction) : { expiresAt: null };
  if (error) return ui.replyError(interaction, error, 'Durée invalide', '⏳');

  const { permissions } = ctx.services;
  let count = 0;
  for (const cat of categories) {
    const rights = rightList.length ? rightList.filter((r) => WEB_CATEGORIES[cat].rights[r]) : [''];
    for (const right of rights) {
      if (granting) await permissions.grantWeb(interaction.guildId, role.id, cat, right, interaction.user.id, expiresAt);
      else await permissions.revokeWeb(interaction.guildId, role.id, cat, right);
      count += 1;
    }
  }

  const scope = categoryList.length ? categoryList.map(categoryLabel).join(', ') : 'toutes les catégories';
  const right_ = rightList.length ? rightList.map((r) => categories.map((c) => rightLabel(c, r)).find((l) => l !== r) ?? r).join(' ; ') : 'tous les droits';
  const temporary = expiresAt ? `\n⏳ Accès temporaire (${formatDuration(seconds)}) : retiré automatiquement ${ui.ts(expiresAt, 'R')}.` : '';
  const card = ui.successCard(
    granting ? 'Accès panel web accordés' : 'Accès panel web retirés',
    `<@&${role.id}> ${granting ? 'a maintenant accès à' : 'n’a plus accès à'} **${right_}** sur **${scope}** du panel web. *(${count} règle${count > 1 ? 's' : ''})*${temporary}`,
    E.permissions,
    categoryList.length
      ? []
      : [
          `\n${E.warning} Sans catégorie précisée, ceci s’applique à **toutes** les catégories du panel web (accès web quasi-admin pour ce rôle).`,
        ],
  );
  await ui.respond(interaction, card, { ephemeral: true });
}

async function listWebGrants(ctx, interaction) {
  const rows = await ctx.services.permissions.allWebGrants(interaction.guildId);
  if (!rows.length) {
    await ui.respond(
      interaction,
      ui.card({
        title: 'Accès au panel web',
        description: 'Aucune restriction configurée : tout compte autorisé du dashboard (`AUTHORIZED_WEB_USERS`) a accès à tout.',
      }),
      { ephemeral: true },
    );
    return;
  }
  // Un élément par rôle ; ses droits regroupés par catégorie du panel, chaque catégorie sur une ligne,
  // droits séparés par une virgule (« tous les droits » absorbe le détail de sa catégorie).
  const byRole = new Map();
  for (const row of rows) {
    if (!byRole.has(row.role_id)) byRole.set(row.role_id, new Map());
    const categories = byRole.get(row.role_id);
    if (!categories.has(row.category)) categories.set(row.category, []);
    categories.get(row.category).push({ key: row.right_key, expiresAt: row.expires_at });
  }
  const entries = [...byRole.entries()];
  const rightText = (category, right) => `${right.key === '' ? 'tous les droits' : rightLabel(category, right.key)}${right.expiresAt ? ` ⏳ ${ui.ts(right.expiresAt, 'R')}` : ''}`;
  const pages = ui.paginateLines(entries, {
    perPage: 5,
    build: (chunk, offset) =>
      ui.card({
        title: `Accès au panel web configurés sur ce serveur. (${entries.length})`,
        body: [
          { stats: [['Rôles', entries.length], ['Règles', rows.length]] },
          ...chunk.map(([roleId, categories], i) => ({
            item: {
              emoji: E.permissions,
              title: `Rôle n°${offset + i + 1}`,
              lines: [
                `🏷️ ${roleMention(interaction.guildId, roleId)}`,
                ...[...categories.entries()]
                  .sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])))
                  .map(([category, rights]) => {
                    const all = rights.find((right) => right.key === '');
                    const text = all ? rightText(category, all) : rights.map((right) => rightText(category, right)).join(', ');
                    return `📂 **${categoryLabel(category)}** : ${text}`;
                  }),
              ],
            },
          })),
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

// ── Diagnostic (/permission check) ────────────────────────────────────────

/** Explique pourquoi un membre peut (ou non) utiliser une commande, en suivant exactement l'ordre du middleware. */
async function checkAccess(ctx, interaction) {
  const name = resolveCommand(ctx, interaction.options.getString('command', true));
  if (!name) return ui.replyError(interaction, 'Commande inconnue : choisis-la dans la liste proposée.');
  const user = interaction.options.getUser('user', true);
  const guild = interaction.guild;
  const member = guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
  if (!member) return ui.replyError(interaction, `<@${user.id}> n’est pas membre de ce serveur.`);

  const result = await explainAccess(ctx, guild, member, name);
  const explanation = explanationText(result, { roleText: (id) => roleMention(guild.id, id), until: (date) => ui.ts(date, 'R') });
  // Règles de ses rôles pour cette commande (même celles qui n'ont pas tranché), utiles au diagnostic.
  const roleLines = result.roleRules.map(
    (rule) => `${rule.allowed ? E.allowed : E.denied} ${roleMention(guild.id, rule.roleId)}${rule.wildcard ? ` (via \`${rule.wildcard}\`)` : ''}${rule.expiresAt ? ` ⏳ ${ui.ts(rule.expiresAt, 'R')}` : ''}`,
  );

  const card = ui.card({
    title: result.allowed ? 'Accès autorisé' : 'Accès refusé',
    description: `👤 <@${user.id}> · \`/${name}\``,
    body: [
      {
        stats: [
          ['Résultat', result.allowed ? 'autorisé' : 'refusé'],
          ['Décidé par', SOURCE_TEXT[result.source]],
          ['Défaut', result.defaultAccess === 'everyone' ? 'tout le monde' : 'administrateurs'],
        ],
      },
      `${result.decisionAllowed ? E.allowed : E.denied} ${explanation}`,
      result.moduleEnabled ? null : `${E.warning} Le module **${result.moduleLabel}** est désactivé sur ce serveur : la commande est refusée à tous (voir /modules).`,
      roleLines.length ? `\n**Règles de ses rôles pour cette commande :**\n${roleLines.join('\n')}` : null,
    ],
  });
  await ui.respond(interaction, card, { ephemeral: true });
}

// ── Modèles et copie de rôle ──────────────────────────────────────────────

function applyOptions(ctx, replace, keepExpiry) {
  return { replace, keepExpiry, isValid: (command) => Boolean(resolveCommand(ctx, command)), isValidWeb: validWebRight };
}

async function saveTemplate(ctx, interaction) {
  const name = interaction.options.getString('nom', true).trim();
  const role = interaction.options.getRole('role', true);
  const { permissions } = ctx.services;
  const snapshot = await permissions.roleSnapshot(interaction.guildId, role.id);
  if (!snapshot.rules.length && !snapshot.web.length) return ui.replyError(interaction, `${roleMention(interaction.guildId, role.id)} n’a aucune règle à enregistrer dans un modèle.`);
  const existing = await permissions.templateByName(interaction.guildId, name);
  const template = await permissions.saveTemplate(interaction.guildId, { name, description: interaction.options.getString('description'), ...snapshot }, interaction.user.id);
  await ui.respond(
    interaction,
    ui.successCard(existing ? 'Modèle mis à jour' : 'Modèle enregistré', `Le modèle **${template.name}** reprend les règles actuelles de ${roleMention(interaction.guildId, role.id)} (accords temporaires enregistrés comme permanents).`, E.permissions, [
      { stats: [['Règles de commandes', template.rules.length], ['Accès panel web', template.web.length]] },
    ]),
    { ephemeral: true },
  );
}

async function applyTemplate(ctx, interaction) {
  const name = interaction.options.getString('nom', true).trim();
  const role = interaction.options.getRole('role', true);
  const replace = interaction.options.getBoolean('remplacer') ?? false;
  const template = await ctx.services.permissions.templateByName(interaction.guildId, name);
  if (!template) return ui.replyError(interaction, `Aucun modèle nommé **${name}** sur ce serveur.`);
  const counts = await ctx.services.permissions.applyToRole(interaction.guildId, role.id, template, interaction.user.id, applyOptions(ctx, replace, false));
  await ui.respond(
    interaction,
    ui.successCard('Modèle appliqué', `Le modèle **${template.name}** a été appliqué à ${roleMention(interaction.guildId, role.id)}${replace ? ' (ses anciennes règles ont été remplacées)' : ' (ses autres règles sont conservées)'}.`, E.permissions, [
      { stats: [['Règles de commandes', counts.rules], ['Accès panel web', counts.web]] },
    ]),
    { ephemeral: true },
  );
}

async function listTemplates(ctx, interaction) {
  const templates = await ctx.services.permissions.listTemplates(interaction.guildId);
  const card = ui.card({
    title: `Modèles de permissions (${templates.length})`,
    body: templates.length
      ? templates.map((t) => ({
          item: {
            emoji: '📋',
            title: t.name,
            lines: [
              t.description ? `*${t.description}*` : null,
              `${t.rules.filter((r) => r.allowed).length} commande(s) autorisée(s) · ${t.rules.filter((r) => !r.allowed).length} bloquée(s) · ${t.web.length} accès panel web`,
            ],
          },
        }))
      : ['Aucun modèle : crée-en un avec `/permission template-save` à partir des règles d’un rôle.'],
  });
  await ui.respond(interaction, card, { ephemeral: true });
}

async function deleteTemplate(ctx, interaction) {
  const name = interaction.options.getString('nom', true).trim();
  const template = await ctx.services.permissions.templateByName(interaction.guildId, name);
  if (!template) return ui.replyError(interaction, `Aucun modèle nommé **${name}** sur ce serveur.`);
  await ctx.services.permissions.deleteTemplate(interaction.guildId, template.id);
  await ui.respond(interaction, ui.successCard('Modèle supprimé', `Le modèle **${template.name}** a été supprimé (les rôles où il a été appliqué gardent leurs règles).`, E.permissions), { ephemeral: true });
}

async function cloneRole(ctx, interaction) {
  const source = interaction.options.getRole('source', true);
  const target = interaction.options.getRole('cible', true);
  if (source.id === target.id) return ui.replyError(interaction, 'Choisis deux rôles différents.');
  const replace = interaction.options.getBoolean('remplacer') ?? false;
  const { permissions } = ctx.services;
  const snapshot = await permissions.roleSnapshot(interaction.guildId, source.id);
  if (!snapshot.rules.length && !snapshot.web.length) return ui.replyError(interaction, `${roleMention(interaction.guildId, source.id)} n’a aucune règle à copier.`);
  const counts = await permissions.applyToRole(interaction.guildId, target.id, snapshot, interaction.user.id, applyOptions(ctx, replace, true));
  await ui.respond(
    interaction,
    ui.successCard(
      'Permissions copiées',
      `Les règles de ${roleMention(interaction.guildId, source.id)} ont été copiées sur ${roleMention(interaction.guildId, target.id)}${replace ? ' (anciennes règles remplacées)' : ''}. Les accords temporaires gardent leur échéance.`,
      E.permissions,
      [{ stats: [['Règles de commandes', counts.rules], ['Accès panel web', counts.web]] }],
    ),
    { ephemeral: true },
  );
}

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('permission')
    .setDescription('Gérer l’accès aux commandes du bot sur ce serveur')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Afficher les permissions configurées sur le serveur')
        .addStringOption((option) =>
          option
            .setName('type')
            .setDescription('Rôles ou utilisateurs')
            .setRequired(true)
            .addChoices({ name: 'Rôles (rank)', value: 'rank' }, { name: 'Utilisateurs (user)', value: 'user' }),
        )
        .addMentionableOption((option) => option.setName('id').setDescription('Rôle ou utilisateur à détailler')),
    )
    .addSubcommand((sub) =>
      // Un seul rôle à la fois, plusieurs commandes possibles (et jokers « module.* »).
      sub
        .setName('grant')
        .setDescription('Autoriser une ou plusieurs commandes (ou module.*) pour un rôle')
        .addRoleOption((option) => option.setName('role').setDescription('Rôle concerné').setRequired(true))
        .addStringOption(commandOption)
        .addStringOption(durationOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('Interdire une ou plusieurs commandes (ou module.*) à un rôle')
        .addRoleOption((option) => option.setName('role').setDescription('Rôle concerné').setRequired(true))
        .addStringOption(commandOption),
    )
    .addSubcommand((sub) =>
      addExtraTargets(
        sub
          .setName('user-grant')
          .setDescription('Autoriser une ou plusieurs commandes pour des utilisateurs (prioritaire sur les rôles)')
          .addUserOption((option) => option.setName('user').setDescription('Utilisateur concerné').setRequired(true))
          .addStringOption(commandOption),
        'user',
      ).addStringOption(durationOption),
    )
    .addSubcommand((sub) =>
      addExtraTargets(
        sub
          .setName('user-revoke')
          .setDescription('Interdire une ou plusieurs commandes à des utilisateurs (prioritaire sur les rôles)')
          .addUserOption((option) => option.setName('user').setDescription('Utilisateur concerné').setRequired(true))
          .addStringOption(commandOption),
        'user',
      ),
    )
    .addSubcommand((sub) =>
      sub.setName('public').setDescription('Rendre une commande publique (ou annuler)').addStringOption(commandOption),
    )
    .addSubcommand((sub) =>
      sub.setName('purge').setDescription('Supprimer toutes les permissions personnalisées du serveur'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('grant-panel')
        .setDescription('Autoriser un rôle sur le panel web (catégorie/droit vides = tout, enchaînables)')
        .addRoleOption((option) => option.setName('role').setDescription('Rôle concerné').setRequired(true))
        .addStringOption((option) => option.setName('categorie').setDescription('Catégorie(s) du panel web, séparées par une virgule (vide = toutes)').setAutocomplete(true))
        .addStringOption((option) => option.setName('droit').setDescription('Droit(s) précis, séparés par une virgule (vide = tous)').setAutocomplete(true))
        .addStringOption(durationOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke-panel')
        .setDescription('Retirer des accès panel web à un rôle')
        .addRoleOption((option) => option.setName('role').setDescription('Rôle concerné').setRequired(true))
        .addStringOption((option) => option.setName('categorie').setDescription('Catégorie(s) du panel web, séparées par une virgule (vide = toutes)').setAutocomplete(true))
        .addStringOption((option) => option.setName('droit').setDescription('Droit(s) précis, séparés par une virgule (vide = tous)').setAutocomplete(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('list-panel').setDescription('Afficher les accès au panel web configurés sur ce serveur'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription('Expliquer pourquoi un membre peut (ou non) utiliser une commande')
        .addUserOption((option) => option.setName('user').setDescription('Membre à vérifier').setRequired(true))
        .addStringOption((option) => option.setName('command').setDescription('Commande à vérifier').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('clone')
        .setDescription('Copier les permissions d’un rôle (commandes et panel web) vers un autre rôle')
        .addRoleOption((option) => option.setName('source').setDescription('Rôle dont les règles sont copiées').setRequired(true))
        .addRoleOption((option) => option.setName('cible').setDescription('Rôle qui reçoit les règles').setRequired(true))
        .addBooleanOption((option) => option.setName('remplacer').setDescription('Effacer d’abord les règles du rôle cible (non par défaut)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('template-save')
        .setDescription('Enregistrer les règles d’un rôle comme modèle réutilisable')
        .addStringOption((option) => option.setName('nom').setDescription('Nom du modèle (remplace un modèle du même nom)').setRequired(true).setMaxLength(50))
        .addRoleOption((option) => option.setName('role').setDescription('Rôle dont les règles forment le modèle').setRequired(true))
        .addStringOption((option) => option.setName('description').setDescription('Description courte du modèle').setMaxLength(200)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('template-apply')
        .setDescription('Appliquer un modèle de permissions à un rôle')
        .addStringOption((option) => option.setName('nom').setDescription('Modèle à appliquer').setRequired(true).setAutocomplete(true))
        .addRoleOption((option) => option.setName('role').setDescription('Rôle qui reçoit les règles').setRequired(true))
        .addBooleanOption((option) => option.setName('remplacer').setDescription('Effacer d’abord les règles du rôle (non par défaut)')),
    )
    .addSubcommand((sub) => sub.setName('template-list').setDescription('Afficher les modèles de permissions du serveur'))
    .addSubcommand((sub) =>
      sub
        .setName('template-delete')
        .setDescription('Supprimer un modèle de permissions')
        .addStringOption((option) => option.setName('nom').setDescription('Modèle à supprimer').setRequired(true).setAutocomplete(true)),
    ),

  async autocomplete(ctx, interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'nom') {
      const typedName = String(focused.value ?? '').toLowerCase();
      const templates = await ctx.services.permissions.listTemplates(interaction.guildId);
      await interaction.respond(
        templates
          .filter((t) => t.name.toLowerCase().includes(typedName))
          .slice(0, 25)
          .map((t) => ({ name: `${t.name}${t.description ? ` — ${t.description}` : ''}`.slice(0, 100), value: t.name })),
      );
      return;
    }

    // Saisie multiple « a, b, c » : on complète le dernier élément et on conserve les précédents dans la valeur.
    const raw = String(focused.value ?? '');
    const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf(';'));
    const done = splitList(lastSeparator >= 0 ? raw.slice(0, lastSeparator) : '');
    const typed = raw.slice(lastSeparator + 1).trim().replace(/^\//, '').toLowerCase();
    const withPrefix = (items) =>
      items
        .filter((item) => !done.includes(item.value))
        .map((item) => ({ name: (done.length ? `${done.join(', ')}, ${item.name}` : item.name).slice(-100), value: [...done, item.value].join(',').slice(0, 100) }))
        .slice(0, 25);

    if (focused.name === 'categorie') {
      await interaction.respond(withPrefix(categoryChoices().filter((c) => c.name.toLowerCase().includes(typed) || c.value.includes(typed))));
      return;
    }
    if (focused.name === 'droit') {
      const categories = splitList(interaction.options.getString('categorie'));
      const seen = new Set();
      const choices = categories
        .flatMap((category) => rightChoices(category))
        .filter((c) => (seen.has(c.value) ? false : seen.add(c.value)))
        .filter((c) => c.name.toLowerCase().includes(typed) || c.value.includes(typed));
      await interaction.respond(withPrefix(choices));
      return;
    }

    const commandChoices = ctx.commands
      .manageableCommands()
      .map((command) => command.data)
      .filter((data) => data.name.includes(typed))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((data) => ({ name: `/${data.name} — ${data.description}`, value: data.name }));
    // Jokers « module.* » (toutes les commandes d'un module) — pas pour /permission check, qui vise une commande.
    const moduleChoices =
      interaction.options.getSubcommand(false) === 'check'
        ? []
        : manageableModules(ctx)
            .map((module) => ({ module, label: module === 'core' ? 'Général' : ctx.modules.labelOf(module) }))
            .filter(({ module, label }) => `${module}.*`.includes(typed) || label.toLowerCase().includes(typed))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(({ module, label }) => ({ name: `📦 ${module}.* — toutes les commandes du module ${label}`, value: `${module}.*` }));
    await interaction.respond(withPrefix([...moduleChoices, ...commandChoices]));
  },

  async execute(ctx, interaction) {
    switch (interaction.options.getSubcommand()) {
      case 'list':
        return listRules(ctx, interaction);
      case 'grant':
        return setRule(ctx, interaction, 'role', true);
      case 'revoke':
        return setRule(ctx, interaction, 'role', false);
      case 'user-grant':
        return setRule(ctx, interaction, 'user', true);
      case 'user-revoke':
        return setRule(ctx, interaction, 'user', false);
      case 'public':
        return togglePublic(ctx, interaction);
      case 'grant-panel':
        return setWebGrant(ctx, interaction, true);
      case 'revoke-panel':
        return setWebGrant(ctx, interaction, false);
      case 'list-panel':
        return listWebGrants(ctx, interaction);
      case 'purge':
        return purge(ctx, interaction);
      case 'check':
        return checkAccess(ctx, interaction);
      case 'clone':
        return cloneRole(ctx, interaction);
      case 'template-save':
        return saveTemplate(ctx, interaction);
      case 'template-apply':
        return applyTemplate(ctx, interaction);
      case 'template-list':
        return listTemplates(ctx, interaction);
      case 'template-delete':
        return deleteTemplate(ctx, interaction);
      default:
        return ui.replyError(interaction, 'Sous-commande inconnue.');
    }
  },
};
