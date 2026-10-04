'use strict';

const path = require('node:path');
const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { HttpError, wrap, isSnowflake } = require('../../../src/web/helpers');
const { WEB_CATEGORIES } = require('../lib/webRights');
const { memberOf } = require('../lib/webAccess');
const { explainAccess, explanationText, SOURCE_TEXT } = require('../lib/check');
const { wildcardModule } = require('../lib/service');
const { parseDuration } = require('../../../src/core/duration');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_GRANT_S = 365 * 86_400;

/** Durée d'un accord temporaire saisie sur le panel : null (permanent) ou date d'échéance ; HttpError si invalide. */
function expiryOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const seconds = parseDuration(value);
  if (!seconds || seconds > MAX_GRANT_S) throw new HttpError(400, 'Durée invalide : par exemple 2h, 3j ou 2sem (1 an maximum).');
  return new Date(Date.now() + seconds * 1000);
}

function validWebRight(category, right) {
  return Boolean(WEB_CATEGORIES[category]) && (right === '' || Boolean(WEB_CATEGORIES[category].rights[right]));
}

function colorHex(color) {
  return color ? `#${color.toString(16).padStart(6, '0')}` : null;
}

/**
 * Interface web du module Permissions (/m/permissions/) : règles de commandes par rôle et par utilisateur,
 * commandes publiques et accès au panel web. Réservée aux **administrateurs du serveur**, à son propriétaire et
 * aux propriétaires du bot (comme /permission : un droit délégué sur le panel ne permet jamais de modifier les droits).
 */
module.exports = function registerWeb(router, ctx) {
  const { permissions } = ctx.services;

  async function isAdmin(guild, userId) {
    if (ctx.config.owners.has(userId) || guild.ownerId === userId) return true;
    const member = await memberOf(guild, userId);
    return Boolean(member?.permissions.has(PermissionFlagsBits.Administrator));
  }

  /** Serveur ciblé par la requête, après vérification que l'utilisateur connecté y est administrateur. */
  async function guildOf(req) {
    const guildId = String(req.query.guild ?? req.body?.guildId ?? '');
    if (!isSnowflake(guildId)) throw new HttpError(400, 'Serveur invalide');
    const guild = ctx.client.guilds.cache.get(guildId);
    if (!guild) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    if (!(await isAdmin(guild, req.session.user.id))) {
      throw new HttpError(403, 'Réservé aux administrateurs du serveur, à son propriétaire et aux propriétaires du bot.');
    }
    return guild;
  }

  /** Commande valide et gérable (celles réservées aux propriétaires du bot sont exclues), comme /permission. */
  /** Commande gérable, ou joker « module.* » d'un module qui a au moins une commande gérable. */
  function manageable(name) {
    const module = wildcardModule(name);
    if (module) return ctx.commands.manageableCommands().some((command) => command.module === module) ? name : null;
    const command = ctx.commands.commands.get(name);
    return command && !command.ownerOnly ? name : null;
  }

  function moduleOf(command) {
    return command.module === 'core' ? { key: 'core', label: 'Général' } : { key: command.module, label: ctx.modules.labelOf(command.module) };
  }

  async function personOf(guild, userId) {
    const member = guild.members.cache.get(userId);
    const user = member?.user ?? ctx.client.users.cache.get(userId) ?? (await ctx.client.users.fetch(userId).catch(() => null));
    return {
      id: userId,
      name: member?.nickname || user?.globalName || user?.username || userId,
      username: user?.username ?? null,
      avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
    };
  }

  async function stateJson(guild) {
    const [roleTargets, userTargets, publics, webGrants, templates] = await Promise.all([
      permissions.listByTarget(guild.id, 'role'),
      permissions.listByTarget(guild.id, 'user'),
      permissions.publicCommands(guild.id),
      permissions.allWebGrants(guild.id),
      permissions.listTemplates(guild.id),
    ]);

    const roleName = (id) => (id === guild.id ? '@everyone' : guild.roles.cache.get(id)?.name ?? `Rôle supprimé (${id})`);
    const roleColor = (id) => colorHex(guild.roles.cache.get(id)?.color ?? 0);

    const grantsByRole = new Map();
    for (const row of webGrants) {
      const roleId = String(row.role_id);
      if (!grantsByRole.has(roleId)) grantsByRole.set(roleId, new Map());
      const categories = grantsByRole.get(roleId);
      if (!categories.has(row.category)) categories.set(row.category, []);
      categories.get(row.category).push({ key: row.right_key, expiresAt: row.expires_at ?? null });
    }

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      commands: ctx.commands
        .manageableCommands()
        .map((command) => ({
          name: command.data.name,
          description: command.data.description,
          module: moduleOf(command).key,
          moduleLabel: moduleOf(command).label,
          defaultAccess: command.permission?.default ?? 'admin',
        }))
        .sort((a, b) => a.moduleLabel.localeCompare(b.moduleLabel) || a.name.localeCompare(b.name)),
      roles: [
        { id: guild.id, name: '@everyone', color: null },
        ...[...guild.roles.cache.values()]
          .filter((role) => role.id !== guild.id)
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ id: role.id, name: role.name, color: colorHex(role.color) })),
      ],
      roleRules: [...roleTargets.entries()].map(([id, entry]) => ({ id, name: roleName(id), color: roleColor(id), allowed: entry.allowed, denied: entry.denied, expiring: entry.expiring })),
      userRules: await Promise.all(
        [...userTargets.entries()].map(async ([id, entry]) => ({ id, person: await personOf(guild, id), allowed: entry.allowed, denied: entry.denied, expiring: entry.expiring })),
      ),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        allowed: t.rules.filter((r) => r.allowed).map((r) => r.command),
        denied: t.rules.filter((r) => !r.allowed).map((r) => r.command),
        web: t.web.filter((g) => validWebRight(g.category, g.right)).map((g) => ({
          category: g.category,
          label: `${WEB_CATEGORIES[g.category].label} : ${g.right === '' ? 'tous les droits' : WEB_CATEGORIES[g.category].rights[g.right]}`,
        })),
        updatedAt: t.updated_at,
      })),
      publics,
      webCategories: Object.entries(WEB_CATEGORIES).map(([key, def]) => ({
        key,
        label: def.label,
        rights: Object.entries(def.rights).map(([rightKey, label]) => ({ key: rightKey, label })),
      })),
      webGrants: [...grantsByRole.entries()].map(([roleId, categories]) => ({
        roleId,
        roleName: roleName(roleId),
        color: roleColor(roleId),
        entries: [...categories.entries()]
          .filter(([category]) => WEB_CATEGORIES[category])
          .map(([category, rights]) => ({
            category,
            categoryLabel: WEB_CATEGORIES[category].label,
            rights: rights.map(({ key, expiresAt }) => ({ key, expiresAt, label: key === '' ? 'Tous les droits' : WEB_CATEGORIES[category].rights[key] ?? key })),
          })),
      })),
    };
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'permissions.html')));

  // Serveurs où l'utilisateur connecté est administrateur.
  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      // Vérifications en parallèle (un membre absent du cache coûte un appel à Discord par serveur).
      const all = [...ctx.client.guilds.cache.values()];
      const admin = await Promise.all(all.map((guild) => isAdmin(guild, req.session.user.id).catch(() => false)));
      const guilds = all.filter((guild, index) => admin[index]).map((guild) => ({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) }));
      res.json(guilds.sort((a, b) => a.name.localeCompare(b.name)));
    }),
  );

  router.get(
    '/api/state',
    wrap(async (req, res) => {
      res.json(await stateJson(await guildOf(req)));
    }),
  );

  // ── Règles de commandes (rôles et utilisateurs) ──────────────────────────
  router.post(
    '/api/rules',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const body = req.body ?? {};
      const kind = body.kind === 'role' || body.kind === 'user' ? body.kind : null;
      if (!kind) throw new HttpError(400, 'Type de cible invalide (rôle ou utilisateur).');
      const targetId = String(body.targetId ?? '').trim();
      if (!isSnowflake(targetId)) throw new HttpError(400, 'Identifiant invalide.');
      if (kind === 'role' && targetId !== guild.id && !guild.roles.cache.has(targetId)) throw new HttpError(404, 'Rôle introuvable sur ce serveur.');
      if (kind === 'user' && !(await ctx.client.users.fetch(targetId).catch(() => null))) throw new HttpError(404, 'Utilisateur Discord introuvable.');
      if (!['allow', 'deny', 'clear'].includes(body.mode)) throw new HttpError(400, 'Action invalide.');

      const names = [...new Set((Array.isArray(body.commands) ? body.commands : []).map((name) => String(name).replace(/^\//, '').toLowerCase()))];
      if (!names.length) throw new HttpError(400, 'Choisis au moins une commande.');
      const unknown = names.filter((name) => !manageable(name));
      if (unknown.length) throw new HttpError(400, `Commande(s) inconnue(s) : ${unknown.join(', ')}.`);

      const actorId = req.session.user.id;
      const expiresAt = body.mode === 'allow' ? expiryOf(body.duration) : null;
      for (const name of names) {
        if (body.mode === 'clear') await permissions.removeRule(kind, guild.id, targetId, name);
        else await permissions.setRule(kind, guild.id, targetId, name, body.mode === 'allow', actorId, expiresAt);
      }
      res.json(await stateJson(guild));
    }),
  );

  // ── Commandes publiques ──────────────────────────────────────────────────
  router.post(
    '/api/public',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const name = String(req.body?.command ?? '').replace(/^\//, '').toLowerCase();
      if (wildcardModule(name) || !manageable(name)) throw new HttpError(400, 'Commande inconnue.');
      await permissions.setPublic(guild.id, name, Boolean(req.body?.public), req.session.user.id);
      res.json(await stateJson(guild));
    }),
  );

  // ── Accès au panel web (équivalent de /permission grant-panel et revoke-panel) ──
  router.post(
    '/api/web-grants',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const body = req.body ?? {};
      const roleId = String(body.roleId ?? '').trim();
      if (!isSnowflake(roleId) || (roleId !== guild.id && !guild.roles.cache.has(roleId))) throw new HttpError(404, 'Rôle introuvable sur ce serveur.');
      const category = String(body.category ?? '');
      const definition = WEB_CATEGORIES[category];
      if (!definition) throw new HttpError(400, 'Catégorie inconnue.');
      if (!['grant', 'revoke'].includes(body.mode)) throw new HttpError(400, 'Action invalide.');
      // Aucun droit précisé = « tous les droits de la catégorie » (clé vide, comme la commande).
      const requested = [...new Set((Array.isArray(body.rights) ? body.rights : []).map(String))];
      const unknown = requested.filter((right) => !definition.rights[right]);
      if (unknown.length) throw new HttpError(400, `Droit(s) inconnu(s) pour ${definition.label} : ${unknown.join(', ')}.`);
      const rights = requested.length ? requested : [''];
      const expiresAt = body.mode === 'grant' ? expiryOf(body.duration) : null;

      for (const right of rights) {
        if (body.mode === 'grant') await permissions.grantWeb(guild.id, roleId, category, right, req.session.user.id, expiresAt);
        else await permissions.revokeWeb(guild.id, roleId, category, right);
      }
      res.json(await stateJson(guild));
    }),
  );

  // ── Diagnostic : pourquoi ce membre peut (ou non) utiliser cette commande ──
  router.post(
    '/api/check',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const userId = String(req.body?.userId ?? '').trim();
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres).');
      const raw = String(req.body?.command ?? '').replace(/^\//, '').toLowerCase();
      const name = wildcardModule(raw) ? null : manageable(raw); // le diagnostic vise une commande précise
      if (!name) throw new HttpError(400, 'Commande inconnue.');
      const member = await memberOf(guild, userId);
      if (!member) throw new HttpError(404, 'Ce membre n’est pas sur le serveur.');
      const result = await explainAccess(ctx, guild, member, name);
      const roleText = (id) => `« ${id === guild.id ? '@everyone' : guild.roles.cache.get(id)?.name ?? id} »`;
      const until = (date) => `jusqu’au ${new Date(date).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`;
      res.json({
        command: name,
        person: await personOf(guild, userId),
        allowed: result.allowed,
        source: SOURCE_TEXT[result.source],
        explanation: explanationText(result, { roleText, until }),
        moduleEnabled: result.moduleEnabled,
        moduleLabel: result.moduleLabel,
        defaultAccess: result.defaultAccess,
        roleRules: result.roleRules.map((rule) => ({ role: roleText(rule.roleId) + (rule.wildcard ? ` (${rule.wildcard})` : ''), allowed: rule.allowed, expiresAt: rule.expiresAt })),
      });
    }),
  );

  // ── Modèles et copie de rôle ─────────────────────────────────────────────

  function roleOf(guild, raw) {
    const roleId = String(raw ?? '').trim();
    if (!isSnowflake(roleId) || (roleId !== guild.id && !guild.roles.cache.has(roleId))) throw new HttpError(404, 'Rôle introuvable sur ce serveur.');
    return roleId;
  }

  const applyOptions = (replace, keepExpiry) => ({ replace, keepExpiry, isValid: (command) => Boolean(manageable(command)), isValidWeb: validWebRight });

  router.post(
    '/api/templates',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const name = String(req.body?.name ?? '').trim().slice(0, 50);
      if (!name) throw new HttpError(400, 'Donne un nom au modèle.');
      const roleId = roleOf(guild, req.body?.roleId);
      const snapshot = await permissions.roleSnapshot(guild.id, roleId);
      if (!snapshot.rules.length && !snapshot.web.length) throw new HttpError(409, 'Ce rôle n’a aucune règle à enregistrer.');
      const description = req.body?.description ? String(req.body.description).trim().slice(0, 200) : null;
      await permissions.saveTemplate(guild.id, { name, description, ...snapshot }, req.session.user.id);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/templates/:id/apply',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const template = await permissions.getTemplate(guild.id, Number(req.params.id) || 0);
      if (!template) throw new HttpError(404, 'Modèle introuvable.');
      const roleId = roleOf(guild, req.body?.roleId);
      await permissions.applyToRole(guild.id, roleId, template, req.session.user.id, applyOptions(req.body?.replace === true, false));
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/templates/:id',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      if (!(await permissions.deleteTemplate(guild.id, Number(req.params.id) || 0))) throw new HttpError(404, 'Modèle introuvable.');
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/clone',
    wrap(async (req, res) => {
      const guild = await guildOf(req);
      const sourceId = roleOf(guild, req.body?.sourceId);
      const targetId = roleOf(guild, req.body?.targetId);
      if (sourceId === targetId) throw new HttpError(400, 'Choisis deux rôles différents.');
      const snapshot = await permissions.roleSnapshot(guild.id, sourceId);
      if (!snapshot.rules.length && !snapshot.web.length) throw new HttpError(409, 'Le rôle source n’a aucune règle à copier.');
      await permissions.applyToRole(guild.id, targetId, snapshot, req.session.user.id, applyOptions(req.body?.replace === true, true));
      res.json(await stateJson(guild));
    }),
  );
};
