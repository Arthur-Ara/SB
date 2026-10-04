'use strict';

/**
 * Verrou par clé : sérialise les tâches partageant la même clé (un salon vocal, un membre…), pour éviter
 * que deux événements quasi simultanés ne soient traités en même temps (doubles expulsions, tickets ou
 * fils modmail créés en double sur un double-clic ou une rafale de messages).
 */
class KeyedMutex {
  constructor() {
    this.chains = new Map();
  }

  run(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const settled = previous.then(task, task);
    // Ne garde la chaîne que tant qu'elle est la plus récente pour cette clé (évite une fuite mémoire).
    const tracked = settled.catch(() => {});
    this.chains.set(key, tracked);
    tracked.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    return settled;
  }
}

module.exports = { KeyedMutex };
