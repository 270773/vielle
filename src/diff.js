// Utilitaires sans dépendance (navigateur + Node) : forme canonique et comparaison de versions.

export const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);

// Même chose sans les identifiants de blocs (un id ne change pas le contenu).
const noIds = (v) => (Array.isArray(v) ? v.map(noIds) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id').map(([k, x]) => [k, noIds(x)])) : v);
const same = (a, b) => canonical(noIds(a)) === canonical(noIds(b));

/** Contenu effectif d'une instance de section répétable : instance > jeu > partagé, pour chaque emplacement. */
export function resolveInstance(block, inst) {
  const names = new Set([...Object.keys(block.shared || {}), ...Object.values(block.presets || {}).flatMap(Object.keys), ...Object.keys(inst.slots || {})]);
  return Object.fromEntries([...names].sort().map((n) => [n, inst.slots?.[n] ?? block.presets?.[inst.preset]?.[n] ?? block.shared?.[n] ?? []]));
}

/** Blocs de premier niveau modifiés ou ajoutés par rapport à la version précédente (marqueur ☞ automatique).
 *  Les sections répétables sont comparées instance par instance (voir changedInstances). */
export function changedBlockIds(prev, cur) {
  const out = new Set();
  if (!prev || !cur?.body) return out;
  const before = new Map((prev.body || []).map((b) => [b.id, b]));
  for (const b of cur.body) {
    if (!b.id || b.type === 'repeat') continue;
    if (!before.has(b.id) || !same(before.get(b.id), b)) out.add(b.id);
  }
  return out;
}

/** Instances (par titre) dont le CONTENU EFFECTIF a changé, ou qui sont nouvelles : « idBloc::titre ».
 *  On compare le contenu résolu, pas le JSON brut : modifier un contenu partagé marque toutes les instances concernées. */
export function changedInstances(prev, cur) {
  const out = new Set();
  if (!prev || !cur?.body) return out;
  for (const b of cur.body) {
    if (b.type !== 'repeat') continue;
    const pb = (prev.body || []).find((x) => x.id === b.id && x.type === 'repeat');
    const old = new Map((pb?.instances || []).map((i) => [i.title, resolveInstance(pb, i)]));
    for (const i of b.instances || []) if (!old.has(i.title) || !same(old.get(i.title), resolveInstance(b, i))) out.add(`${b.id}::${i.title}`);
  }
  return out;
}
