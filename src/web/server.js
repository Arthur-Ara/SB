'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { createAuth, SESSION_COOKIE, safeReturnTo } = require('./auth');
const { ActivityLog } = require('./activity');
const { MySQLSessionStore } = require('./sessionStore');
const { loadChangelog, TYPES: CHANGELOG_TYPES } = require('../core/changelog');

/** Fonctionnalités du cœur, présentées sur la page « Fonctionnalités ». */
const CORE_FEATURES = [
  'Slash commands uniquement, chargées et rechargées à chaud par module (/modules)',
  'Activation des modules serveur par serveur (/modules, administrateurs)',
  'Admins globaux du bot avec /admin : tous les serveurs, tous les modules et le panel web (propriétaires du bot)',
  'Aide interactive (/help) qui ne montre que les commandes utilisables',
  'Panel web avec connexion Discord, notifications et journal d’activité détaillé (ce qui a été modifié)',
  'Changelog public de chaque version (/changelog et page Changelog)',
];

const PUBLIC_DIR = path.join(__dirname, 'public');
const FONT_PACKAGES = {
  inter: '@fontsource-variable/inter',
  'jetbrains-mono': '@fontsource-variable/jetbrains-mono',
};

function resolveChartJs() {
  try {
    const distDir = path.dirname(require.resolve('chart.js'));
    for (const file of ['chart.umd.min.js', 'chart.umd.js']) {
      const candidate = path.join(distDir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // chart.js non installé
  }
  return null;
}

/** Démarre le dashboard web centralisé (Express) et monte les interfaces des modules. */
async function startWebServer(core) {
  const { config, modules } = core;
  const log = core.logger.child('web');
  const secure = config.web.callbackUrl.startsWith('https://');

  if (!config.web.authorizedUsers.size) {
    log.warn('AUTHORIZED_WEB_USERS est vide : personne ne pourra accéder au dashboard.');
  }
  const callback = new URL(config.web.callbackUrl);
  const callbackPort = Number(callback.port || (callback.protocol === 'https:' ? 443 : 80));
  if (!config.web.trustProxy && callbackPort !== config.web.port) {
    log.warn(
      `WEB_CALLBACK_URL utilise le port ${callbackPort} alors que le dashboard écoute sur le port ${config.web.port} : ` +
        'la connexion Discord échouera. Corrigez WEB_CALLBACK_URL (et l’URL de redirection OAuth2 du portail Discord).',
    );
  }
  if (config.web.sessionSecretGenerated) {
    log.warn('SESSION_SECRET absent : secret temporaire généré, les sessions seront invalidées au redémarrage.');
  }

  const app = express();
  app.disable('x-powered-by');
  if (config.web.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Les transcripts affichent des images/GIF/vidéos hébergées ailleurs (Tenor, Giphy, liens d'embeds).
          'img-src': ["'self'", 'data:', 'https:'],
          'media-src': ["'self'", 'https:'],
          'upgrade-insecure-requests': secure ? [] : null,
        },
      },
      strictTransportSecurity: secure,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  const store = new MySQLSessionStore(core.db);
  app.use(
    session({
      name: SESSION_COOKIE,
      secret: config.web.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: config.web.trustProxy,
      cookie: { httpOnly: true, sameSite: 'lax', secure, maxAge: 7 * 24 * 60 * 60 * 1000 },
    }),
  );

  const activity = new ActivityLog({ db: core.db, logger: log });
  activity.start();
  app.use(activity.middleware());

  // Ressources publiques (page de connexion, styles, scripts du cœur).
  // maxAge: 0 (revalidation systématique, via ETag) — un cache plus long servirait un vieux .js
  // après un redéploiement pendant que la .html, elle, change tout de suite (page cassée le temps du cache).
  app.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  const chartJs = resolveChartJs();
  app.get('/vendor/chart.js', (req, res) => (chartJs ? res.sendFile(chartJs) : res.status(404).end()));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  // Polices de la charte (Inter, JetBrains Mono), servies depuis node_modules sans CDN.
  for (const [name, pkg] of Object.entries(FONT_PACKAGES)) {
    const dir = path.join(config.rootDir, 'node_modules', ...pkg.split('/'));
    if (fs.existsSync(dir)) app.use(`/vendor/fonts/${name}`, express.static(dir, { index: false, maxAge: '30d' }));
    else log.warn(`Police ${pkg} non installée : repli sur les polices système (npm install).`);
  }

  const auth = createAuth(core, PUBLIC_DIR, {
    onLogin: (user) =>
      activity.record({ userId: user.id, username: user.globalName || user.username, action: 'login', path: '/auth' }).catch(() => {}),
  });
  app.get('/login', (req, res) => {
    if (auth.isAuthenticated(req)) return res.redirect(safeReturnTo(req.query.next));
    return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });
  app.use(auth.router);

  // ── Pages publiques (sans connexion) : le changelog est consultable par tout le monde ──
  // Seuls des textes destinés au public y figurent (changelog.json) : aucune donnée de serveur ni de membre.
  app.get('/changelog', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'changelog.html')));

  // Page « Fonctionnalités » : modules, commandes et fonctionnalités du bot (aucune donnée de serveur ni de membre).
  app.get('/features', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'features.html')));
  app.get('/api/features', (req, res) => {
    const { version } = require('../../package.json');
    res.set('Cache-Control', 'no-store');
    res.json({
      version,
      core: { label: 'Cœur', emoji: '⚙️', description: 'Socle du bot, actif partout.', features: CORE_FEATURES, commands: core.commands.describeFor('core') },
      modules: modules.list().map((m) => ({
        name: m.name,
        label: m.label,
        emoji: m.emoji,
        description: m.description,
        features: m.features,
        required: m.required,
        defaultEnabled: m.defaultEnabled,
        loaded: m.loaded,
        web: m.hasWeb ? `/m/${m.name}/` : null,
        commands: core.commands.describeFor(m.name),
      })),
    });
  });
  app.get('/api/changelog', (req, res) => {
    const label = (key) => (key === 'core' ? 'Général' : key === 'web' ? 'Panel web' : modules.labelOf(key));
    res.set('Cache-Control', 'no-store');
    res.json({
      types: CHANGELOG_TYPES,
      entries: loadChangelog().map((entry) => ({ ...entry, changes: entry.changes.map((change) => ({ ...change, moduleLabel: label(change.module) })) })),
    });
  });
  // Visiteur connecté ou non (pages publiques) : { user } ou { user: null }, jamais d'erreur 401.
  app.get('/api/session', (req, res) => res.json({ user: auth.isAuthenticated(req) ? req.session.user : null }));

  // ── Tout ce qui suit exige une session autorisée ──────────────────────────
  app.use(auth.requireAuth);

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'home.html')));
  app.get('/api/me', (req, res) => res.json(req.session.user));
  app.get('/api/modules', (req, res) => res.json(modules.webEntries()));
  app.get('/api/status', (req, res) => {
    const { client } = core;
    res.json({
      online: client.isReady(),
      tag: client.user?.tag ?? null,
      avatar: client.user?.displayAvatarURL({ size: 128 }) ?? null,
      guilds: client.guilds.cache.size,
      ping: client.ws.ping,
      uptime: client.uptime,
      modules: modules.list(),
    });
  });

  // ── Journal d'activité du panel : les propriétaires du bot voient tout, les autres comptes leurs propres actions ──
  app.get('/activity', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'activity.html')));
  /** Détail d'une action, mentions Discord (<@&id> <#id> <@id>) remplacées par les noms du serveur concerné. */
  const readableDetail = (row) => {
    if (!row.detail) return null;
    const guild = row.guild_id ? core.client.guilds.cache.get(String(row.guild_id)) : null;
    return String(row.detail)
      .replace(/<@&(\d{15,25})>/g, (m, id) => `@${guild?.roles.cache.get(id)?.name ?? id}`)
      .replace(/<#(\d{15,25})>/g, (m, id) => `#${guild?.channels.cache.get(id)?.name ?? id}`)
      .replace(/<@!?(\d{15,25})>/g, (m, id) => `@${core.client.users.cache.get(id)?.username ?? id}`);
  };

  app.get('/api/activity', async (req, res, next) => {
    try {
      const me = req.session.user.id;
      const isOwner = config.owners.has(me);
      const requested = /^\d{17,20}$/.test(String(req.query.user ?? '')) ? String(req.query.user) : null;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const module = /^[\w-]{1,64}$/.test(String(req.query.module ?? '')) ? String(req.query.module) : null;
      const { rows, total } = await activity.list({ userId: isOwner ? requested : me, module, limit: 50, offset: (page - 1) * 50 });
      const label = (key) => (key ? modules.labelOf(key) : null);
      res.set('Cache-Control', 'no-store');
      res.json({
        isOwner,
        page,
        pages: Math.max(1, Math.ceil(total / 50)),
        total,
        modules: modules.webEntries().map((m) => ({ key: m.name, label: m.label })),
        rows: rows.map((row) => ({
          id: row.id,
          userId: String(row.user_id),
          username: row.username,
          action: row.action,
          path: row.path,
          module: row.module,
          moduleLabel: label(row.module),
          guild: row.guild_id ? core.client.guilds.cache.get(String(row.guild_id))?.name ?? String(row.guild_id) : null,
          status: row.status,
          detail: readableDetail(row),
          createdAt: row.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Notifications du panel : chaque module propose les siennes (hook `webNotifications`) ──
  app.get('/api/notifications', async (req, res, next) => {
    try {
      const items = await modules.callHook('webNotifications', null, req.session.user.id);
      res.set('Cache-Control', 'no-store');
      res.json(items.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30));
    } catch (err) {
      next(err);
    }
  });

  modules.mountWeb(app);

  app.use((req, res) => {
    if (/\/api\//.test(req.originalUrl)) return res.status(404).json({ error: 'Ressource introuvable' });
    return res.status(404).type('text').send('Page introuvable');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return undefined;
    if (/\/api\//.test(req.originalUrl)) {
      return res.status(status).json({ error: status >= 500 ? 'Erreur interne' : err.message });
    }
    return res.status(status).type('text').send(status >= 500 ? 'Erreur interne' : err.message);
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(config.web.port, () => resolve(instance));
    instance.on('error', reject);
  });
  log.info(`Dashboard : ${callback.origin} (écoute sur le port ${config.web.port}, source : ${config.web.portSource})`);

  return {
    app,
    async close() {
      store.close();
      activity.stop();
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startWebServer };
