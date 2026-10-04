'use strict';

// Les URL du CDN Discord (message.attachments) sont signées et expirent : on conserve une copie en base pour
// le transcript web. Au-delà de cette taille on renonce à télécharger (pas de fichier énorme en mémoire) :
// compromis assumé, pas de stockage disque disponible.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Télécharge une pièce jointe Discord et la confie à `save({ name, contentType, size, buffer })` (qui renvoie
 * l'id de la ligne enregistrée). Renvoie la description à stocker avec le message (id null si non conservée).
 * Partagé par les tickets (events/messageCreate.js) et le modmail (lib/modmail.js).
 */
async function downloadAttachment(attachment, save, logger) {
  const base = { name: attachment.name, size: attachment.size, contentType: attachment.contentType };
  if (attachment.size > MAX_ATTACHMENT_BYTES) return { id: null, ...base, tooLarge: true };
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const id = await save({ name: attachment.name, contentType: attachment.contentType, size: buffer.length, buffer });
    return { id, ...base, size: buffer.length };
  } catch (err) {
    logger.warn(`Téléchargement de la pièce jointe "${attachment.name}" impossible`, err.message);
    return { id: null, ...base, failed: true };
  }
}

/** Autocollants d'un message (images du CDN Discord, permanentes ; le format Lottie n'est pas pris en charge). */
function stickersOf(message) {
  return [...(message.stickers?.values() ?? [])].filter((s) => s.format !== 3).map((s) => ({ external: true, name: s.name, url: s.url }));
}

module.exports = { MAX_ATTACHMENT_BYTES, downloadAttachment, stickersOf };
