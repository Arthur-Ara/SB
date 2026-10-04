'use strict';

const { askAutoClose } = require('./autoclose');
const { isWithinSchedule, panelSchedule } = require('./schedule');
// Chargés à la demande : lifecycle.js et modmail.js n'ont pas besoin du planificateur (pas de dépendance circulaire).
const deleteTicket = (...args) => require('./lifecycle').deleteTicket(...args);
const closeModmail = (...args) => require('./modmail').closeModmail(...args);

const SWEEP_MS = 60_000;

/**
 * Balayage périodique (comme ModerationScheduler côté Modération) : demande de confirmation de clôture
 * au staff pour les tickets sans réponse de l'ouvreur, et reping du staff quand un ticket attend une réponse depuis trop
 * longtemps — tous deux réglables par type, et soumis à la plage horaire d'activation du panel
 * auquel appartient le ticket (ticket_panels.schedule_*), désactivée par défaut donc actif en
 * permanence tant que non réglée.
 */
class TicketScheduler {
  constructor({ client, service, logger, ctx }) {
    this.client = client;
    this.service = service;
    this.logger = logger;
    this.ctx = ctx;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
    this.sweep();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep() {
    // Un balayage plus long que l'intervalle ne doit pas en chevaucher un autre (rappels envoyés en double).
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepAutoClose().catch((err) => this.logger.error('Balayage clôture automatique impossible', err));
      await this.sweepReping().catch((err) => this.logger.error('Balayage reping impossible', err));
      await this.sweepAutoDelete().catch((err) => this.logger.error('Balayage suppression automatique impossible', err));
      await this.sweepModmail().catch((err) => this.logger.error('Balayage du modmail impossible', err));
    } finally {
      this.sweeping = false;
    }
  }

  async sweepAutoClose() {
    for (const row of await this.service.dueForAutoClose()) {
      try {
        const guild = this.client.guilds.cache.get(row.guild_id);
        if (!guild) continue;
        const panel = await this.service.getPanel(row.panel_id);
        if (!isWithinSchedule(panelSchedule(panel))) continue;
        const channel = guild.channels.cache.get(row.channel_id);
        if (!channel) continue;
        if (!channel.isTextBased()) continue;
        const type = await this.service.getType(row.type_id);
        if (!type) continue;
        // Plus de fermeture d'office : le staff doit confirmer (boutons dans le salon, voir lib/autoclose.js).
        await askAutoClose(this.ctx, row, type, channel);
      } catch (err) {
        this.logger.warn(`Demande de clôture automatique du ticket #${row.id} impossible`, err.message);
      }
    }
  }

  /**
   * Suppression automatique du salon des tickets fermés depuis plus de `auto_delete_hours` (option du type) :
   * même effet qu'un clic sur « Supprimer le salon » (archive dans le journal, notation si activée).
   * Indépendante de la plage horaire du panel (simple rangement).
   */
  async sweepAutoDelete() {
    for (const ticket of await this.service.dueForAutoDelete()) {
      try {
        const guild = this.client.guilds.cache.get(String(ticket.guild_id));
        if (!guild) continue;
        if (!this.ctx.modules.isEnabledFor('tickets', guild.id)) continue;
        const channel = guild.channels.cache.get(String(ticket.channel_id));
        if (!channel) {
          await this.service.markDeleted(ticket.id); // salon déjà disparu : rien à supprimer
          continue;
        }
        const type = await this.service.getType(ticket.type_id);
        await deleteTicket(this.ctx, { ticket, type, channel, executorId: null });
      } catch (err) {
        this.logger.warn(`Suppression automatique du ticket #${ticket.id} impossible`, err.message);
      }
    }
  }

  /** Fermeture automatique des fils modmail inactifs (option `auto_close_hours` de leur catégorie). */
  async sweepModmail() {
    for (const thread of await this.service.dueModmailAutoClose()) {
      try {
        if (!this.ctx.modules.isEnabledFor('tickets', String(thread.guild_id))) continue;
        const hours = Number(thread.auto_close_hours);
        await closeModmail(this.ctx, thread, { closedBy: null, reason: `Fermeture automatique : aucune activité depuis ${hours} h.`, notifyUser: true });
      } catch (err) {
        this.logger.warn(`Fermeture automatique du modmail #${thread.id} impossible`, err.message);
      }
    }
  }

  async sweepReping() {
    for (const row of await this.service.dueForReping()) {
      try {
        const guild = this.client.guilds.cache.get(row.guild_id);
        if (!guild) continue;
        const panel = await this.service.getPanel(row.panel_id);
        if (!isWithinSchedule(panelSchedule(panel))) continue;
        const channel = guild.channels.cache.get(row.channel_id);
        if (!channel?.isTextBased()) continue;
        const type = await this.service.getType(row.type_id);
        if (!type) continue;
        // Ticket pris en charge : seul celui qui l'a pris est repingué (les rôles ne sont pas dérangés).
        // Sinon : rôle(s) à repinger explicitement réglés (ou rôle(s) notifié(s) si la case « mêmes rôles »
        // est cochée) ; à défaut, rôle(s) modérateur, pour ne jamais envoyer un rappel muet.
        let mentions;
        if (row.claimed_by) {
          mentions = `<@${row.claimed_by}>`;
        } else {
          const configured = type.reping_same_as_notify ? type.notify_role_ids : type.reping_role_ids;
          const roleIds = configured.length ? configured : type.mod_role_ids;
          mentions = roleIds.map((id) => `<@&${id}>`).join(' ');
        }
        const template = type.reping_message?.trim();
        let content;
        if (template) {
          const filled = template
            .replace(/\{staff\}/g, mentions || '')
            .replace(/\{user\}/g, `<@${row.opener_id}>`)
            .replace(/\{ticket\}/g, `#${row.id}`)
            .replace(/\{number\}/g, String(row.id).padStart(4, '0'))
            .replace(/\{type\}/g, type.label)
            .replace(/\{channel\}/g, `<#${row.channel_id}>`);
          // Sans {staff} dans le message, les rôles sont mentionnés devant : le rappel doit toujours pinguer.
          content = template.includes('{staff}') ? filled : `${mentions} ${filled}`.trim();
        } else {
          content = `${mentions || '⏰'} Rappel : ce ticket attend une réponse du staff depuis un moment.`;
        }
        await channel.send({
          content: content.slice(0, 2000),
          allowedMentions: { parse: ['roles', 'users'] },
        });
        await this.service.markReping(row.id);
      } catch (err) {
        this.logger.warn(`Reping du ticket #${row.id} impossible`, err.message);
      }
    }
  }
}

module.exports = { TicketScheduler };
