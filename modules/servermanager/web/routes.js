'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, wrap, isSnowflake, avatarUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess, memberOf } = require('../../permissions/lib/webAccess');
const { parseDuration, formatDuration } = require('../lib/duration');
const { SCOPE_LABEL } = require('../lib/constants');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PLAN_TTL_MS = 10 * 60_000;
const JOB_TTL_MS = 60 * 60_000;
const KINDS = new Set(['channel', 'role', 'member_role']);

/**
 * Interface web du Server Manager (/m/servermanager/) : journal des modifications, rollbacks (aperçu puis
 * exécution suivie en direct), historique, sauvegardes et réglages. Mêmes garde-fous que les commandes : le
 * compte connecté doit être membre du serveur, et ce sont **ses** droits Discord qui sont vérifiés par le moteur.
 */
module.exports = function registerWeb(router, ctx) {
  const { store, engine, backups, limits } = ctx.services;
  const access = guildAccess(ctx, { module: 'servermanager', category: 'servermanager', label: 'Server Manager' });
  const plans = new Map(); // jeton → { kind, guildId, userId, plan | hash, backupId, at }
  const jobs = new Map(); // id → { guildId, userId, kind, status, progress, result, abort, at }

  function cleanup() {
    const now = Date.now();
    for (const [token, entry] of plans) if (now - entry.at > PLAN_TTL_MS) plans.delete(token);
    for (const [id, job] of jobs) if (job.status !== 'running' && now - job.at > JOB_TTL_MS) jobs.delete(id);
  }

  function person(guild, userId) {
    if (!userId) return null;
    const id = String(userId);
    const member = guild.members.cache.get(id);
    const user = member?.user ?? ctx.client.users.cache.get(id);
    return { id, name: member?.displayName || user?.globalName || user?.username || id, avatar: avatarUrl(id, user?.avatar ?? null) };
  }

  /** Mentions Discord (<@id>, <@&id>, <#id>) remplacées par des noms lisibles sur le panel. */
  function plain(guild, text) {
    return String(text ?? '')
      .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name ?? id}`)
      .replace(/<@!?(\d+)>/g, (_, id) => `@${person(guild, id).name}`)
      .replace(/<#(\d+)>/g, (_, id) => `#${guild.channels.cache.get(id)?.name ?? id}`)
      .replace(/\*\*/g, '');
  }

  async function invokerOf(req, guild) {
    const member = await memberOf(guild, req.session.user.id);
    if (!member) throw new HttpError(403, 'Tu dois être membre de ce serveur : ce sont tes droits Discord qui encadrent l’opération.');
    return member;
  }

  function itemJson(guild, item) {
    return {
      key: item.key,
      title: plain(guild, item.title),
      kind: item.kind,
      op: item.op,
      at: item.at,
      executor: person(guild, item.executorId),
      status: item.status,
      reason: item.reason ? plain(guild, item.reason) : null,
      destructive: item.destructive,
      notes: item.notes.map((note) => plain(guild, note)),
    };
  }

  function startJob({ guildId, userId, kind, run }) {
    cleanup();
    const id = crypto.randomUUID();
    const job = { guildId, userId, kind, status: 'running', progress: { index: 0, total: 0, label: null }, result: null, abort: { requested: false }, at: Date.now() };
    jobs.set(id, job);
    run(job)
      .then((result) => {
        job.result = result;
        job.status = result?.error ? 'failed' : 'done';
      })
      .catch((err) => {
        ctx.logger.error(`Tâche ${kind} du panel interrompue`, err);
        job.result = { error: `Erreur inattendue : ${err.message}` };
        job.status = 'failed';
      })
      .finally(() => {
        job.at = Date.now();
      });
    return id;
  }

  function jobOf(req) {
    const job = jobs.get(String(req.params.id));
    if (!job || job.userId !== req.session.user.id) throw new HttpError(404, 'Tâche introuvable ou expirée.');
    return job;
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'servermanager.html')));

  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      res.json(await access.guilds(req));
    }),
  );

  router.get(
    '/api/state',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const [settings, size] = await Promise.all([store.settings(guild.id), store.journalSize(guild.id)]);
      res.json({
        guild: { id: guild.id, name: guild.name },
        settings: {
          logChannelId: settings.logChannelId ? String(settings.logChannelId) : null,
          trackingSince: settings.trackingSince,
          backupEnabled: settings.backupEnabled,
          backupIntervalHours: settings.backupIntervalHours,
          backupKeep: settings.backupKeep,
          lastBackupAt: settings.lastBackupAt,
        },
        journal: size,
        limits: { maxWindow: formatDuration(limits.maxWindowS), maxActions: limits.maxActions, retentionDays: limits.retentionDays, cooldownS: limits.cooldownS },
        scopes: Object.entries(SCOPE_LABEL).map(([key, label]) => ({ key, label })),
        textChannels: [...guild.channels.cache.values()]
          .filter((c) => c.isTextBased() && !c.isThread() && !c.isVoiceBased())
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .map((c) => ({ id: c.id, name: c.name })),
      });
    }),
  );

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const body = req.body ?? {};
      const interval = Number(body.backupIntervalHours);
      const keep = Number(body.backupKeep);
      if (!Number.isInteger(interval) || interval < 1 || interval > 720) throw new HttpError(400, 'Intervalle invalide (1 à 720 heures).');
      if (!Number.isInteger(keep) || keep < 1 || keep > 50) throw new HttpError(400, 'Nombre de sauvegardes conservées invalide (1 à 50).');
      await store.setLogChannel(guild.id, textChannelId(guild, body.logChannelId));
      await store.updateBackupSettings(guild.id, { backup_enabled: body.backupEnabled === true ? 1 : 0, backup_interval_hours: interval, backup_keep: keep });
      res.json({ ok: true });
    }),
  );

  // ── Journal des modifications ────────────────────────────────────────────

  router.get(
    '/api/changes',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const kind = KINDS.has(String(req.query.kind)) ? String(req.query.kind) : null;
      const executorId = req.query.executor ? String(req.query.executor) : null;
      if (executorId && !isSnowflake(executorId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres).');
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = 50;
      const { rows, total } = await store.changes(guild.id, { kind, executorId, limit: pageSize, offset: (page - 1) * pageSize });
      res.json({
        page,
        pages: Math.max(1, Math.ceil(total / pageSize)),
        total,
        rows: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          op: row.op,
          label: row.label,
          targetId: String(row.target_id),
          roleName: row.role_id ? guild.roles.cache.get(String(row.role_id))?.name ?? String(row.role_id) : null,
          executor: person(guild, row.executor_id),
          createdAt: row.created_at,
          rolledBackAt: row.rolled_back_at,
          batchId: row.batch_id,
        })),
      });
    }),
  );

  // ── Rollbacks ────────────────────────────────────────────────────────────

  router.get(
    '/api/batches',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const rows = await store.history(guild.id, 100);
      res.json(
        rows.map((row) => ({
          id: row.id,
          invoker: person(guild, row.invoker_id),
          scope: SCOPE_LABEL[row.scope] ?? row.scope,
          window: formatDuration(row.window_s),
          target: person(guild, row.target_user_id),
          status: row.status,
          planned: row.planned,
          applied: row.applied,
          skipped: row.skipped,
          failed: row.failed,
          createdAt: row.created_at,
        })),
      );
    }),
  );

  router.get(
    '/api/batches/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const batch = await store.batch(guild.id, Number(req.params.id) || 0);
      if (!batch) throw new HttpError(404, 'Rollback introuvable');
      res.json({
        id: batch.id,
        report: batch.report.map((item) => ({ title: plain(guild, item.title), status: item.status, reason: item.reason ? plain(guild, item.reason) : null, executor: person(guild, item.executorId) })),
      });
    }),
  );

  router.post(
    '/api/rollback/preview',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'rollback');
      const invoker = await invokerOf(req, guild);
      const scope = String(req.body?.scope ?? '');
      const windowS = parseDuration(req.body?.duration);
      if (!windowS) throw new HttpError(400, 'Durée invalide. Exemples : 30m, 2h, 1d, 1d12h.');
      const targetUserId = req.body?.userId ? String(req.body.userId) : null;
      if (targetUserId && !isSnowflake(targetUserId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres).');
      const plan = await engine.plan({ guild, invoker, scope, windowS, targetUserId });
      if (plan.error) throw new HttpError(409, plain(guild, plan.error));
      cleanup();
      const token = crypto.randomUUID();
      plans.set(token, { kind: 'rollback', guildId: guild.id, userId: invoker.id, plan, at: Date.now() });
      res.json({
        token,
        scope: SCOPE_LABEL[plan.scope],
        window: formatDuration(plan.windowS),
        since: plan.since,
        stats: { ...plan.stats, reasons: plan.stats.reasons.map(([reason, count]) => ({ reason: plain(guild, reason), count })) },
        warnings: plan.warnings.map((w) => plain(guild, w)),
        tooMany: plan.tooMany,
        sensitive: plan.sensitive,
        code: plan.sensitive ? `ROLLBACK ${plan.stats.ok}` : null,
        items: plan.items.map((item) => itemJson(guild, item)),
      });
    }),
  );

  router.post(
    '/api/rollback/execute',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'rollback');
      const invoker = await invokerOf(req, guild);
      const entry = plans.get(String(req.body?.token ?? ''));
      if (!entry || entry.kind !== 'rollback' || entry.guildId !== guild.id || entry.userId !== invoker.id) throw new HttpError(410, 'Aperçu expiré : relance l’aperçu.');
      const { plan } = entry;
      if (plan.tooMany || !plan.stats.ok) throw new HttpError(409, 'Rien à exécuter pour cet aperçu.');
      if (plan.sensitive && String(req.body?.code ?? '').trim().toUpperCase() !== `ROLLBACK ${plan.stats.ok}`) throw new HttpError(400, 'Code de confirmation incorrect : rien n’a été exécuté.');
      plans.delete(String(req.body.token));
      const jobId = startJob({
        guildId: guild.id,
        userId: invoker.id,
        kind: 'rollback',
        run: async (job) => {
          const result = await engine.run(plan, {
            guild,
            invoker,
            abort: job.abort,
            onProgress: ({ index, total, item }) => {
              job.progress = { index, total, label: item ? plain(guild, item.title) : null };
            },
          });
          if (result.error) return { error: plain(guild, result.error) };
          return {
            batchId: result.batchId,
            aborted: result.aborted,
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed,
            cancelled: result.cancelled,
            items: result.items.filter((item) => item.status === 'done' || item.status === 'failed').map((item) => itemJson(guild, item)),
          };
        },
      });
      res.json({ jobId });
    }),
  );

  router.get(
    '/api/jobs/:id',
    wrap(async (req, res) => {
      const job = jobOf(req);
      res.json({ kind: job.kind, status: job.status, progress: job.progress, result: job.result });
    }),
  );

  router.post(
    '/api/jobs/:id/stop',
    wrap(async (req, res) => {
      const job = jobOf(req);
      job.abort.requested = true;
      res.json({ ok: true });
    }),
  );

  // ── Sauvegardes ──────────────────────────────────────────────────────────

  router.get(
    '/api/backups',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const rows = await store.listBackups(guild.id);
      res.json(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          origin: row.origin,
          roles: row.roles_count,
          channels: row.channels_count,
          size: row.size_bytes,
          createdBy: person(guild, row.created_by),
          createdAt: row.created_at,
          restoredAt: row.restored_at,
          restoredBy: person(guild, row.restored_by),
        })),
      );
    }),
  );

  router.post(
    '/api/backups',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'backup');
      const name = req.body?.name ? String(req.body.name).trim().slice(0, 80) : null;
      res.json(await backups.create(guild, { name, createdBy: req.session.user.id }));
    }),
  );

  router.delete(
    '/api/backups/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'backup');
      const id = Number(req.params.id) || 0;
      if (!(await store.deleteBackup(guild.id, id))) throw new HttpError(404, 'Sauvegarde introuvable');
      await backups.log(guild.id, `🗑️ Sauvegarde **#${id}** supprimée depuis le panel web par <@${req.session.user.id}>.`);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/api/backups/:id/preview',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'backup');
      const invoker = await invokerOf(req, guild);
      const preview = await backups.preview(guild, Number(req.params.id) || 0, invoker);
      if (preview.error) throw new HttpError(409, preview.error);
      cleanup();
      const token = crypto.randomUUID();
      plans.set(token, { kind: 'restore', guildId: guild.id, userId: invoker.id, backupId: preview.backup.id, hash: preview.plan.hash, at: Date.now() });
      res.json({
        token,
        code: `RESTAURER ${preview.backup.id}`,
        backup: { id: preview.backup.id, name: preview.backup.name, createdAt: preview.backup.created_at },
        actions: preview.plan.actions.map((a) => ({ type: a.type, label: a.label })),
        skipped: preview.plan.skipped,
      });
    }),
  );

  router.post(
    '/api/backups/:id/restore',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'backup');
      const invoker = await invokerOf(req, guild);
      const entry = plans.get(String(req.body?.token ?? ''));
      const backupId = Number(req.params.id) || 0;
      if (!entry || entry.kind !== 'restore' || entry.guildId !== guild.id || entry.userId !== invoker.id || entry.backupId !== backupId) {
        throw new HttpError(410, 'Aperçu expiré : relance l’aperçu.');
      }
      if (String(req.body?.code ?? '').trim().toUpperCase() !== `RESTAURER ${backupId}`) throw new HttpError(400, 'Code de confirmation incorrect : rien n’a été restauré.');
      plans.delete(String(req.body.token));
      const jobId = startJob({
        guildId: guild.id,
        userId: invoker.id,
        kind: 'restore',
        run: (job) =>
          backups.restore(guild, backupId, invoker, {
            expectedHash: entry.hash,
            abort: job.abort,
            onProgress: (progress) => {
              job.progress = progress;
            },
          }),
      });
      res.json({ jobId });
    }),
  );
};
