'use strict';

const ui = require('../../../src/bot/ui');

const E = ui.EMOJIS;

const onOff = (value) => (value ? 'activé' : 'désactivé');
const mentions = (ids) => ids.map((id) => `<@${id}>`).join(', ');

/** Salon vocal d'un membre au format « 🔊 #Vocal ( 3 ) », ou « Hors vocal ». */
function voiceLine(guild, userId) {
  const channelId = guild.voiceStates.cache.get(userId)?.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  return channel ? `${E.voice} <#${channel.id}> ( \`${channel.members.size}\` )` : '🔇 Hors vocal';
}

/** Confirmation d'une modification : « 🔗 texte » + bloc « Avant / Après » éventuel. */
function success(title, description, fields) {
  const stats = (fields ?? []).map(({ name, value }) => [name, String(value).replace(/\*\*/g, '')]);
  return ui.successCard(title, description, E.leash, stats.length ? [{ stats }] : []);
}

/** Laisse d'un membre, paginée : un élément par membre en laisse. Partagé par /laisse list et /laisse-admin list. */
async function sendList(interaction, { leash, guild, state }, leasherId, heading) {
  const ids = leash.listOf(state, leasherId);
  const limit = leash.limitFor(state, leasherId);
  const client = interaction.client;
  const pages = ui.paginateLines(ids, {
    perPage: 5,
    build: (chunk, offset) =>
      ui.card({
        title: `${heading} (${ids.length}/${limit})`,
        body: [
          { stats: [['Total', ids.length], ['Limite', limit]] },
          `${E.user} <@${leasherId}> · ${voiceLine(guild, leasherId)}`,
          ...chunk.map((id, i) => {
            const link = state.links.get(id);
            return {
              item: {
                emoji: E.dog,
                title: `Membre n°${offset + i + 1}`,
                lines: [
                  `${E.clock} En laisse depuis le ${ui.dateTime(link?.createdAt)}`,
                  `${E.user} <@${id}>`,
                  voiceLine(guild, id),
                  leash.member(state, id).immune ? '🛡️ Immunisé : n’est pas déplacé' : null,
                ],
                details: [`Membre: ${ui.userLabel(client, id)}`, `Ajouté par: ${link?.addedBy ? ui.userLabel(client, link.addedBy) : '—'}`],
              },
            };
          }),
          chunk.length ? null : '\nPersonne n’est en laisse.',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

/** Liste paginée des membres ayant un statut donné (autorisé, immunisé, god mode, admin). */
async function flagView({ interaction, leash, guild }, flag, title, emoji) {
  const rows = await leash.withFlag(guild.id, flag);
  const client = interaction.client;
  const pages = ui.paginateLines(rows, {
    perPage: 5,
    build: (chunk, offset) =>
      ui.card({
        title: `${title} (${rows.length})`,
        body: [
          { stats: [['Total', rows.length]] },
          ...chunk.map((row, i) => ({
            item: {
              emoji,
              title: `Membre n°${offset + i + 1}`,
              lines: [`${E.clock} Ajouté le ${ui.dateTime(row.at)}`, `${E.user} <@${row.userId}>`],
              details: [`Membre: ${ui.userLabel(client, row.userId)}`, `Ajouté par: ${row.by ? ui.userLabel(client, row.by) : '—'}`],
            },
          })),
          chunk.length ? null : '\nPersonne.',
        ],
      }),
  });
  await ui.sendPaginated(interaction, pages, { ephemeral: true });
}

module.exports = { E, onOff, mentions, voiceLine, success, sendList, flagView };
