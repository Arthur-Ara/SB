'use strict';

const { parseParams } = require('./conditions');
const { roleProblem } = require('./safety');

/** Message lisible pour une erreur Discord lors de l'ajout / du retrait d'un rôle. */
function friendlyError(err) {
  if (err?.code === 50013) return 'le bot n’a pas la permission de gérer ce rôle (son propre rôle est trop bas ?).';
  if (err?.code === 10011) return 'ce rôle n’existe plus.';
  return String(err?.message ?? 'erreur inconnue').slice(0, 120);
}

/** Texte récapitulatif d'une série de résultats (réponse éphémère au membre). */
function describe(results) {
  const lines = [];
  for (const result of results) {
    const role = `<@&${result.option.role_id}>`;
    if (result.kind === 'added') {
      lines.push(`✅ Rôle ajouté : ${role}`);
      for (const other of result.removed ?? []) lines.push(`➖ Rôle retiré : <@&${other.role_id}>`);
    } else if (result.kind === 'removed') lines.push(`➖ Rôle retiré : ${role}`);
    else if (result.kind === 'already') lines.push(`ℹ️ Tu as déjà ${role}.`);
    else if (result.kind === 'absent') lines.push(`ℹ️ Tu n’as pas ${role}.`);
    else lines.push(`❌ ${role} : ${result.message}`);
  }
  return lines.join('\n') || 'Rien n’a changé.';
}

/** Attribution et retrait des rôles d'un menu, conditions et plafonds compris. */
class RoleMenuEngine {
  constructor({ service, conditions, logger, allowSensitive = false }) {
    this.service = service;
    this.conditions = conditions;
    this.logger = logger;
    this.flags = { allowSensitive };
    this.chains = new Map();
  }

  /** Exécute les opérations d'un même membre l'une après l'autre (clics ou réactions en rafale). */
  serialize(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.chains.set(key, next);
    next
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      })
      .catch(() => {});
    return next;
  }

  heldSet(member) {
    return new Set(member.roles.cache.keys());
  }

  /** Raisons pour lesquelles le membre ne remplit pas les conditions du menu et de l'option (liste vide = autorisé). */
  async refusals(member, bundle, option) {
    const reasons = [];
    for (const condition of bundle.conditions) {
      if (condition.option_id !== null && String(condition.option_id) !== String(option.id)) continue;
      const verdict = await this.conditions.check(condition.type, parseParams(condition.params), member);
      if (!verdict.ok) reasons.push(verdict.reason);
    }
    return reasons;
  }

  async grant(member, bundle, option, held) {
    const { menu, options } = bundle;
    const roleId = String(option.role_id);
    if (held.has(roleId)) return { kind: 'already', option };

    const problem = roleProblem(member.guild, roleId, this.flags);
    if (problem) return { kind: 'error', option, message: `ce rôle ne peut pas être attribué (${problem}).` };
    const reasons = await this.refusals(member, bundle, option);
    if (reasons.length) return { kind: 'denied', option, message: reasons.join(' ') };

    const others = options.filter((o) => String(o.id) !== String(option.id) && held.has(String(o.role_id)));
    if (menu.mode === 'multiple' && menu.max_selected && others.length >= menu.max_selected) {
      return { kind: 'denied', option, message: `tu as déjà ${others.length} rôle(s) de ce menu (maximum ${menu.max_selected}) : retires-en un d’abord.` };
    }

    const reason = `RôleMenu « ${menu.name} »`;
    try {
      await member.roles.add(roleId, reason);
    } catch (err) {
      return { kind: 'error', option, message: friendlyError(err) };
    }
    held.add(roleId);

    // Mode « un seul rôle » : prendre un rôle retire les autres rôles du menu.
    const removed = [];
    if (menu.mode === 'single') {
      for (const other of others) {
        try {
          await member.roles.remove(String(other.role_id), reason);
          held.delete(String(other.role_id));
          removed.push(other);
        } catch {
          // Retrait impossible : le membre garde l'autre rôle, on ne bloque pas pour autant.
        }
      }
    }
    return { kind: 'added', option, removed };
  }

  async revoke(member, bundle, option, held) {
    const roleId = String(option.role_id);
    if (!held.has(roleId)) return { kind: 'absent', option };
    if (!bundle.menu.removable) return { kind: 'denied', option, message: 'ce rôle ne peut pas être retiré depuis ce menu.' };
    try {
      await member.roles.remove(roleId, `RôleMenu « ${bundle.menu.name} »`);
    } catch (err) {
      return { kind: 'error', option, message: friendlyError(err) };
    }
    held.delete(roleId);
    return { kind: 'removed', option };
  }

  /** Bouton ou réaction : un clic ajoute le rôle, un second le retire. */
  toggle(member, bundle, option) {
    return this.serialize(`${member.guild.id}:${member.id}`, async () => {
      const held = this.heldSet(member);
      return [held.has(String(option.role_id)) ? await this.revoke(member, bundle, option, held) : await this.grant(member, bundle, option, held)];
    });
  }

  add(member, bundle, option) {
    return this.serialize(`${member.guild.id}:${member.id}`, async () => [await this.grant(member, bundle, option, this.heldSet(member))]);
  }

  remove(member, bundle, option) {
    return this.serialize(`${member.guild.id}:${member.id}`, async () => [await this.revoke(member, bundle, option, this.heldSet(member))]);
  }

  /**
   * Menu déroulant : la sélection devient l'état voulu pour les rôles du menu
   * (rôles décochés retirés, rôles cochés ajoutés).
   */
  sync(member, bundle, selectedIds) {
    return this.serialize(`${member.guild.id}:${member.id}`, async () => {
      const held = this.heldSet(member);
      const wanted = new Set(selectedIds.map(String));
      const results = [];
      const toGrant = bundle.options.filter((o) => wanted.has(String(o.id)) && !held.has(String(o.role_id)));
      const toRevoke = bundle.options.filter((o) => !wanted.has(String(o.id)) && held.has(String(o.role_id)));
      // « Un seul rôle » : changer de choix remplace l'ancien (géré par grant) ; seule une sélection vide retire.
      if (!(bundle.menu.mode === 'single' && toGrant.length)) {
        for (const option of toRevoke) results.push(await this.revoke(member, bundle, option, held));
      }
      for (const option of toGrant) results.push(await this.grant(member, bundle, option, held));
      return results;
    });
  }
}

module.exports = { RoleMenuEngine, describe };
