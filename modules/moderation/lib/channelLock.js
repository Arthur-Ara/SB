'use strict';

/** Permissions modifiées par un verrouillage — noms tels qu'attendus par PermissionOverwriteManager#edit. */
const LOCK_PERMISSIONS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];

/** true = autorisée, false = refusée, null = ni l'une ni l'autre (héritée). */
function currentState(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.id); // @everyone
  const state = {};
  for (const perm of LOCK_PERMISSIONS) {
    if (overwrite?.allow.has(perm)) state[perm] = true;
    else if (overwrite?.deny.has(perm)) state[perm] = false;
    else state[perm] = null;
  }
  return state;
}

/** Un salon est déjà considéré verrouillé si l'écriture est explicitement refusée pour @everyone. */
function isChannelLocked(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
  return Boolean(overwrite?.deny.has('SendMessages'));
}

async function lockChannel(service, channel, executorId, reason) {
  await service.saveLockState(channel.guild.id, channel.id, currentState(channel), executorId);
  const deny = Object.fromEntries(LOCK_PERMISSIONS.map((perm) => [perm, false]));
  await channel.permissionOverwrites.edit(channel.guild.id, deny, { reason: reason ?? 'Salon verrouillé' });
}

/** Restaure l'état précédent (ou lève juste le refus si aucun état n'a été mémorisé). */
async function unlockChannel(service, channel, executorId, reason) {
  const previous = await service.lockState(channel.guild.id, channel.id);
  const patch = {};
  for (const perm of LOCK_PERMISSIONS) patch[perm] = previous ? previous[perm] : null;
  await channel.permissionOverwrites.edit(channel.guild.id, patch, { reason: reason ?? 'Salon déverrouillé' });
  await service.clearLockState(channel.guild.id, channel.id);
}

module.exports = { LOCK_PERMISSIONS, isChannelLocked, lockChannel, unlockChannel };
