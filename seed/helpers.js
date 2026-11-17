// Petits constructeurs de blocs pour écrire les documents pilotes.
export const H = (text, level = 1, numbered = true) => ({ type: 'heading', text, level, numbered });
export const P = (text) => ({ type: 'text', text });
export const UL = (items, o = {}) => ({ type: 'list', style: 'bullet', items, ...o });
export const OL = (items, format = '{n}.', o = {}) => ({ type: 'list', style: 'number', format, items, ...o });
export const CHECKLIST = (items) => ({ type: 'list', style: 'check', items });
export const CALL = (text, kind = 'attention', label) => ({ type: 'callout', kind, text, ...(label && { label }) });
export const KV = (rows, o = {}) => ({ type: 'keyvalue', rows, ...o });
export const BOX = (title, children) => ({ type: 'box', title, children });
export const COLS = (widths, cells) => ({ type: 'columns', widths, cells });
export const PHOTOS = (items, perRow) => ({ type: 'photos', perRow: perRow || items.length, items });
export const IMG = (src, caption, width) => ({ type: 'image', src, caption, width });
export const SLOT = (slot) => ({ type: 'slot', slot });

/** Attribue un identifiant stable à chaque bloc (utile pour le marqueur ☞ et l'édition). */
export function withIds(doc) {
  let n = 0;
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (typeof x.type === 'string' && !x.id && x.type !== 'slot') x.id = `b${++n}`;
    Object.values(x).forEach(walk);
  };
  walk(doc.body); walk(doc.card);
  return doc;
}
