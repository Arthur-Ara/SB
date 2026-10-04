'use strict';

const { ChannelType } = require('discord.js');
const { roleProblem, parseEmoji } = require('./safety');
const { LIMITS, TYPE_LABEL, MODE_LABEL, checkOptions, publishMenu, refreshMenuMessage, fetchMenuMessage } = require('./message');

const MENU_TYPES = ['reaction', 'button', 'select'];
const MODES = ['multiple', 'single'];
const STYLES = ['primary', 'secondary', 'success', 'danger'];
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const COLOR = /^#[0-9a-f]{6}$/i;
const URL_PATTERN = /^https?:\/\/\S+$/i;

function text(value, max) {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Opérations d'administration de RôleMenu, partagées par la commande /rolemenu et le panel web : mêmes
 * validations, mêmes garde-fous, même journal. Chaque méthode renvoie `{ error }` ou son résultat.
 *
 * `actor` : { id, name, web: boolean, member: GuildMember | null }. Quand `member` est connu, on interdit de
 * rendre auto-attribuable un rôle au-dessus de son propre rôle le plus haut (sauf propriétaire du serveur).
 */
class RoleMenuConfig {
  constructor({ client, service, conditions, logs, logger, allowSensitive = false }) {
    this.client = client;
    this.service = service;
    this.conditions = conditions;
    this.logs = logs;
    this.logger = logger;
    this.flags = { allowSensitive };
  }

  async menuOf(guild, menuId) {
    const menu = await this.service.getMenu(menuId);
    return menu && String(menu.guild_id) === guild.id ? menu : null;
  }

  hierarchyProblem(guild, actor, roleId) {
    const role = guild.roles.cache.get(String(roleId));
    if (!role || !actor.member || actor.id === guild.ownerId) return null;
    return role.position >= actor.member.roles.highest.position ? 'ce rôle est au-dessus (ou au niveau) de ton rôle le plus haut' : null;
  }

  /** Une option ne doit pas permettre de s'attribuer un rôle que le bot n'a pas le droit d'attribuer. */
  rolePermitted(guild, actor, roleId) {
    const problem = roleProblem(guild, roleId, this.flags) ?? this.hierarchyProblem(guild, actor, roleId);
    return problem ? `Ce rôle ne peut pas être utilisé : ${problem}.` : null;
  }

  async refresh(guild, menuId) {
    const menu = await this.service.getMenu(menuId);
    if (!menu) return { warnings: [] };
    try {
      return await refreshMenuMessage(this.client, this.service, menu);
    } catch (err) {
      this.logger.warn(`Mise à jour du message du menu #${menuId} impossible`, err.message);
      return { warnings: ['Le message publié n’a pas pu être mis à jour.'] };
    }
  }

  // ── Menus ─────────────────────────────────────────────────────────────────

  async createMenu(guild, actor, input) {
    const name = text(input.name, 100);
    if (!name) return { error: 'Donne un nom au menu.' };
    if (!MENU_TYPES.includes(input.type)) return { error: 'Type inconnu (réactions, boutons ou menu déroulant).' };
    if (!MODES.includes(input.mode)) return { error: 'Mode inconnu (plusieurs rôles ou un seul).' };
    const maxSelected = Math.min(Math.max(parseInt(input.maxSelected, 10) || 0, 0), 25);
    const menu = await this.service.createMenu(guild.id, { name, type: input.type, mode: input.mode, maxSelected });
    await this.logs.change(guild.id, actor, `menu **${name}** créé (n°${menu.id} · ${TYPE_LABEL[menu.type]} · ${MODE_LABEL[menu.mode]}).`);
    return { menu };
  }

  async updateMenu(guild, actor, menuId, input) {
    const menu = await this.menuOf(guild, menuId);
    if (!menu) return { error: 'Menu introuvable.' };
    const patch = {};

    if ('name' in input) {
      const name = text(input.name, 100);
      if (!name) return { error: 'Le nom ne peut pas être vide.' };
      patch.name = name;
    }
    if ('type' in input) {
      if (!MENU_TYPES.includes(input.type)) return { error: 'Type inconnu.' };
      patch.type = input.type;
    }
    if ('mode' in input) {
      if (!MODES.includes(input.mode)) return { error: 'Mode inconnu.' };
      patch.mode = input.mode;
    }
    if ('maxSelected' in input) patch.max_selected = Math.min(Math.max(parseInt(input.maxSelected, 10) || 0, 0), 25);
    if ('removable' in input) patch.removable = input.removable ? 1 : 0;
    if ('placeholder' in input) patch.placeholder = text(input.placeholder, 150);
    if ('embedTitle' in input) patch.embed_title = text(input.embedTitle, 256);
    if ('embedDescription' in input) patch.embed_description = text(input.embedDescription, 4000);
    if ('embedFooter' in input) patch.embed_footer = text(input.embedFooter, 2048);
    if ('embedColor' in input) {
      const color = text(input.embedColor, 16);
      if (color && !COLOR.test(color)) return { error: 'Couleur invalide (format #RRGGBB).' };
      patch.embed_color = color;
    }
    for (const [key, column] of [['embedImage', 'embed_image'], ['embedThumbnail', 'embed_thumbnail']]) {
      if (!(key in input)) continue;
      const url = text(input[key], 512);
      if (url && !URL_PATTERN.test(url)) return { error: 'Les images doivent être des liens http(s).' };
      patch[column] = url;
    }

    if (patch.type) {
      const options = await this.service.listOptions(menu.id);
      const problem = checkOptions({ ...menu, type: patch.type }, options);
      if (problem) return { error: `Changement de type impossible : ${problem}` };
    }
    await this.service.updateMenu(menu.id, patch);
    const { warnings } = await this.refresh(guild, menu.id);
    await this.logs.change(guild.id, actor, `menu **${patch.name ?? menu.name}** (n°${menu.id}) modifié.`);
    return { menu: await this.service.getMenu(menu.id), warnings };
  }

  async deleteMenu(guild, actor, menuId) {
    const menu = await this.menuOf(guild, menuId);
    if (!menu) return { error: 'Menu introuvable.' };
    const message = await fetchMenuMessage(this.client, menu).catch(() => null);
    if (message) await message.delete().catch(() => {});
    await this.service.deleteMenu(menu.id);
    await this.logs.change(guild.id, actor, `menu **${menu.name}** (n°${menu.id}) supprimé.`);
    return { ok: true };
  }

  async publish(guild, actor, menuId, channel) {
    const menu = await this.menuOf(guild, menuId);
    if (!menu) return { error: 'Menu introuvable.' };
    if (!channel || channel.guildId !== guild.id || !TEXT_TYPES.has(channel.type)) return { error: 'Salon textuel introuvable.' };
    let result;
    try {
      result = await publishMenu(this.client, this.service, menu, channel);
    } catch (err) {
      return { error: `Publication impossible : ${err.message}` };
    }
    if (result.error) return { error: result.error };
    await this.logs.change(guild.id, actor, `menu **${menu.name}** (n°${menu.id}) publié dans <#${channel.id}>.`);
    return { message: result.message, warnings: result.warnings };
  }

  // ── Options ───────────────────────────────────────────────────────────────

  /** Valide un émoji saisi pour une option de ce menu (unicité pour les réactions). */
  emojiProblem(menu, options, emojiText, selfId = null) {
    const parsed = parseEmoji(emojiText);
    if (!parsed) return { error: 'Émoji invalide (Unicode, ou <:nom:id> pour un émoji personnalisé du serveur).' };
    const clash = options.find((o) => String(o.id) !== String(selfId) && parseEmoji(o.emoji)?.key === parsed.key);
    if (menu.type === 'reaction' && clash) return { error: `L’émoji ${parsed.raw} est déjà utilisé dans ce menu.` };
    return { emoji: parsed.raw };
  }

  async addOption(guild, actor, menuId, input) {
    const menu = await this.menuOf(guild, menuId);
    if (!menu) return { error: 'Menu introuvable.' };
    const roleId = String(input.roleId ?? '');
    const problem = this.rolePermitted(guild, actor, roleId);
    if (problem) return { error: problem };

    const options = await this.service.listOptions(menu.id);
    if (options.some((o) => String(o.role_id) === roleId)) return { error: 'Ce rôle est déjà dans ce menu.' };
    if (options.length >= LIMITS[menu.type]) return { error: `Ce type de menu accepte ${LIMITS[menu.type]} options au maximum.` };

    let emoji = null;
    if (text(input.emoji, 80)) {
      const checked = this.emojiProblem(menu, options, input.emoji);
      if (checked.error) return checked;
      emoji = checked.emoji;
    } else if (menu.type === 'reaction') {
      return { error: 'Un menu à réactions exige un émoji pour chaque option.' };
    }
    const style = STYLES.includes(input.style) ? input.style : 'secondary';
    const option = await this.service.addOption(menu.id, {
      roleId,
      label: text(input.label, 80),
      emoji,
      description: text(input.description, 100),
      style,
    });
    const { warnings } = await this.refresh(guild, menu.id);
    await this.logs.change(guild.id, actor, `menu **${menu.name}** : option ajoutée <@&${roleId}>.`);
    return { option, warnings };
  }

  async updateOption(guild, actor, optionId, input) {
    const option = await this.service.getOption(optionId);
    const menu = option ? await this.menuOf(guild, option.menu_id) : null;
    if (!option || !menu) return { error: 'Option introuvable.' };
    const patch = {};
    if ('label' in input) patch.label = text(input.label, 80);
    if ('description' in input) patch.description = text(input.description, 100);
    if ('style' in input) {
      if (!STYLES.includes(input.style)) return { error: 'Style de bouton inconnu.' };
      patch.style = input.style;
    }
    if ('emoji' in input) {
      if (text(input.emoji, 80)) {
        const options = await this.service.listOptions(menu.id);
        const checked = this.emojiProblem(menu, options, input.emoji, option.id);
        if (checked.error) return checked;
        patch.emoji = checked.emoji;
      } else if (menu.type === 'reaction') {
        return { error: 'Un menu à réactions exige un émoji pour chaque option.' };
      } else {
        patch.emoji = null;
      }
    }
    await this.service.updateOption(option.id, patch);
    const { warnings } = await this.refresh(guild, menu.id);
    await this.logs.change(guild.id, actor, `menu **${menu.name}** : option <@&${option.role_id}> modifiée.`);
    return { option: await this.service.getOption(option.id), warnings };
  }

  async removeOption(guild, actor, optionId) {
    const option = await this.service.getOption(optionId);
    const menu = option ? await this.menuOf(guild, option.menu_id) : null;
    if (!option || !menu) return { error: 'Option introuvable.' };
    await this.service.deleteOption(option.id);
    const { warnings } = await this.refresh(guild, menu.id);
    await this.logs.change(guild.id, actor, `menu **${menu.name}** : option <@&${option.role_id}> retirée.`);
    return { ok: true, warnings };
  }

  async removeOptionByRole(guild, actor, menuId, roleId) {
    const options = await this.service.listOptions(menuId);
    const option = options.find((o) => String(o.role_id) === String(roleId));
    if (!option) return { error: 'Ce rôle n’est pas dans ce menu.' };
    return this.removeOption(guild, actor, option.id);
  }

  async moveOption(guild, actor, optionId, direction) {
    const option = await this.service.getOption(optionId);
    const menu = option ? await this.menuOf(guild, option.menu_id) : null;
    if (!option || !menu) return { error: 'Option introuvable.' };
    if (direction !== -1 && direction !== 1) return { error: 'Direction invalide.' };
    await this.service.moveOption(option.id, direction);
    const { warnings } = await this.refresh(guild, menu.id);
    return { ok: true, warnings };
  }

  // ── Conditions ────────────────────────────────────────────────────────────

  async addCondition(guild, actor, menuId, optionId, type, raw) {
    const menu = await this.menuOf(guild, menuId);
    if (!menu) return { error: 'Menu introuvable.' };
    let option = null;
    if (optionId) {
      option = await this.service.getOption(optionId);
      if (!option || String(option.menu_id) !== String(menu.id)) return { error: 'Option introuvable dans ce menu.' };
    }
    const checked = this.conditions.validate(type, raw, guild);
    if (checked.error) return checked;
    const condition = await this.service.addCondition(menu.id, option?.id ?? null, type, checked.params);
    await this.logs.change(
      guild.id,
      actor,
      `menu **${menu.name}** : condition ajoutée${option ? ` sur <@&${option.role_id}>` : ''} — ${this.conditions.summarize(type, checked.params)}.`,
    );
    return { condition };
  }

  async removeCondition(guild, actor, conditionId) {
    const condition = await this.service.getCondition(conditionId);
    const menu = condition ? await this.menuOf(guild, condition.menu_id) : null;
    if (!condition || !menu) return { error: 'Condition introuvable.' };
    await this.service.deleteCondition(condition.id);
    await this.logs.change(guild.id, actor, `menu **${menu.name}** : condition n°${condition.id} retirée.`);
    return { ok: true };
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async setLogChannel(guild, actor, channelId) {
    if (channelId) {
      const channel = guild.channels.cache.get(String(channelId));
      if (!channel || !TEXT_TYPES.has(channel.type)) return { error: 'Salon textuel introuvable.' };
    }
    await this.service.setLogChannel(guild.id, channelId || null);
    await this.logs.change(guild.id, actor, `salon de journal : ${channelId ? `<#${channelId}>` : 'aucun'}.`);
    return { ok: true };
  }
}

module.exports = { RoleMenuConfig, TEXT_TYPES };
