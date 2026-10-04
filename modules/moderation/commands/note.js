'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');

/** Notes internes du staff sur un membre : jamais visibles par lui, distinctes des sanctions. */
module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('note')
    .setDescription('Notes internes du staff sur un membre (invisibles pour lui)')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter une note interne sur un membre')
        .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('Contenu de la note').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) =>
      s
        .setName('liste')
        .setDescription('Afficher les notes internes d’un membre')
        .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Supprimer une note interne')
        .addIntegerOption((o) => o.setName('id').setDescription('Numéro de la note').setRequired(true).setMinValue(1)),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { moderation, logs } = ctx.services;
    const sub = interaction.options.getSubcommand();

    if (sub === 'ajouter') {
      const user = interaction.options.getUser('user', true);
      const text = interaction.options.getString('texte', true);
      const id = await moderation.addNote(guild.id, user.id, interaction.user.id, text);
      await logs.send(guild.id, ui.card({ description: `🗒️ <@${interaction.user.id}> a ajouté la note n°${id} sur <@${user.id}>.`, timestamp: true }));
      return ui.respond(interaction, ui.successCard('Note ajoutée', `Note n°${id} enregistrée sur <@${user.id}>.\n> ${text.replace(/\n/g, '\n> ')}`, '🗒️'), { ephemeral: true });
    }

    if (sub === 'liste') {
      const user = interaction.options.getUser('user', true);
      const notes = await moderation.listNotes(guild.id, user.id);
      const body = notes.length
        ? notes.slice(0, 15).map((note) => `**n°${note.id}** · <@${note.author_id}> · ${ui.ts(note.created_at, 'R')}\n> ${String(note.content).slice(0, 300).replace(/\n/g, '\n> ')}`)
        : ['*Aucune note interne sur ce membre.*'];
      if (notes.length > 15) body.push(`-# … et ${notes.length - 15} autres (voir le panel web).`);
      return ui.respond(interaction, ui.card({ title: `🗒️ Notes internes (${notes.length})`, description: `👤 <@${user.id}>`, body }), { ephemeral: true });
    }

    const id = interaction.options.getInteger('id', true);
    const note = await moderation.getNote(guild.id, id);
    if (!note) return ui.replyError(interaction, `Aucune note n°${id} sur ce serveur.`, 'Introuvable', '🗒️');
    await moderation.deleteNote(guild.id, id);
    await logs.send(guild.id, ui.card({ description: `🗒️ <@${interaction.user.id}> a supprimé la note n°${id} sur <@${note.user_id}>.`, timestamp: true }));
    return ui.respond(interaction, ui.successCard('Note supprimée', `La note n°${id} sur <@${note.user_id}> a été supprimée.`, '🗒️'), { ephemeral: true });
  },
};
