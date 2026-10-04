'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, wrap, isSnowflake } = require('../../../src/web/helpers');
const { guildAccess, memberOf } = require('../../permissions/lib/webAccess');
const { parseParams } = require('../lib/conditions');
const { roleProblem } = require('../lib/safety');
const { LIMITS } = require('../lib/message');
const { TEXT_TYPES } = require('../lib/config');

const PUBLIC_DIR = path.join(__dirname, 'public');

/** Les opérations de configuration renvoient `{ error }` : on la transforme en réponse 400. */
function unwrap(result) {
  if (result?.error) throw new HttpError(400, result.error);
  return result;
}

function colorHex(color) {
  return color ? `#${color.toString(16).padStart(6, '0')}` : null;
}

/** Interface web du module RôleMenu (/m/rolemenu/) : menus, options et conditions. */
module.exports = function registerWeb(router, ctx) {
  const { rolemenu: service, config, conditions, allowSensitive } = ctx.services;
  const access = guildAccess(ctx, { module: 'rolemenu', category: 'rolemenu', label: 'RôleMenu' });

  /** Auteur de l'action : membre récupéré auprès de Discord si besoin, pour que la hiérarchie des rôles soit toujours vérifiée. */
  async function actorOf(req, guild) {
    const user = req.session.user;
    return { id: user.id, name: user.globalName || user.username, web: true, member: await memberOf(guild, user.id) };
  }

  function plain(guild, text) {
    return text.replace(/<@&(\d+)>/g, (match, id) => `@${guild.roles.cache.get(id)?.name ?? id}`);
  }

  function menuJson(guild, bundle) {
    const { menu, options, conditions: rows } = bundle;
    return {
      id: menu.id,
      name: menu.name,
      type: menu.type,
      mode: menu.mode,
      maxSelected: menu.max_selected,
      removable: Boolean(menu.removable),
      placeholder: menu.placeholder,
      channelId: menu.channel_id,
      messageId: menu.message_id,
      embedTitle: menu.embed_title,
      embedDescription: menu.embed_description,
      embedColor: menu.embed_color,
      embedFooter: menu.embed_footer,
      embedImage: menu.embed_image,
      embedThumbnail: menu.embed_thumbnail,
      limit: LIMITS[menu.type],
      options: options.map((option) => ({
        id: option.id,
        roleId: option.role_id,
        roleName: guild.roles.cache.get(String(option.role_id))?.name ?? null,
        label: option.label,
        emoji: option.emoji,
        description: option.description,
        style: option.style,
        problem: roleProblem(guild, option.role_id, { allowSensitive }),
      })),
      conditions: rows.map((row) => {
        const params = parseParams(row.params);
        return {
          id: row.id,
          optionId: row.option_id,
          type: row.type,
          known: conditions.has(row.type),
          summary: plain(guild, conditions.summarize(row.type, params)),
        };
      }),
    };
  }

  async function stateJson(guild) {
    const [settings, menus] = await Promise.all([service.settings(guild.id), service.listMenus(guild.id)]);
    const bundles = await Promise.all(menus.map((menu) => service.bundle(menu.id)));
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      settings: { logChannelId: settings.logChannelId },
      textChannels: [...guild.channels.cache.values()]
        .filter((c) => TEXT_TYPES.has(c.type))
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.id, name: c.name })),
      roles: [...guild.roles.cache.values()]
        .filter((role) => role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name, color: colorHex(role.color), problem: roleProblem(guild, role.id, { allowSensitive }) })),
      conditionTypes: conditions.list(),
      menus: bundles.filter(Boolean).map((bundle) => menuJson(guild, bundle)),
    };
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'rolemenu.html')));

  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      res.json(await access.guilds(req));
    }),
  );

  router.get(
    '/api/state',
    wrap(async (req, res) => {
      res.json(await stateJson(await access.guild(req, 'view')));
    }),
  );

  /** Route d'écriture : droit « manage », exécution de l'opération, puis nouvel état complet. */
  function mutation(method, route, operation) {
    router[method](
      route,
      wrap(async (req, res) => {
        const guild = await access.guild(req, 'manage');
        unwrap(await operation({ req, guild, actor: await actorOf(req, guild), body: req.body ?? {} }));
        res.json(await stateJson(guild));
      }),
    );
  }

  mutation('post', '/api/settings', ({ guild, actor, body }) => config.setLogChannel(guild, actor, body.logChannelId ? String(body.logChannelId) : null));

  // ── Menus ─────────────────────────────────────────────────────────────────
  mutation('post', '/api/menus', ({ guild, actor, body }) => config.createMenu(guild, actor, body));
  mutation('post', '/api/menus/:id', ({ req, guild, actor, body }) => config.updateMenu(guild, actor, req.params.id, body));
  mutation('delete', '/api/menus/:id', ({ req, guild, actor }) => config.deleteMenu(guild, actor, req.params.id));
  mutation('post', '/api/menus/:id/publish', ({ req, guild, actor, body }) => {
    const channelId = String(body.channelId ?? '');
    if (!isSnowflake(channelId)) return { error: 'Salon invalide.' };
    return config.publish(guild, actor, req.params.id, guild.channels.cache.get(channelId));
  });

  // ── Options ───────────────────────────────────────────────────────────────
  mutation('post', '/api/menus/:id/options', ({ req, guild, actor, body }) => config.addOption(guild, actor, req.params.id, body));
  mutation('post', '/api/options/:id', ({ req, guild, actor, body }) => config.updateOption(guild, actor, req.params.id, body));
  mutation('delete', '/api/options/:id', ({ req, guild, actor }) => config.removeOption(guild, actor, req.params.id));
  mutation('post', '/api/options/:id/move', ({ req, guild, actor, body }) => config.moveOption(guild, actor, req.params.id, Number(body.direction)));

  // ── Conditions ────────────────────────────────────────────────────────────
  mutation('post', '/api/conditions', ({ guild, actor, body }) =>
    config.addCondition(guild, actor, body.menuId, body.optionId || null, String(body.type ?? ''), body.params ?? {}),
  );
  mutation('delete', '/api/conditions/:id', ({ req, guild, actor }) => config.removeCondition(guild, actor, req.params.id));

};
