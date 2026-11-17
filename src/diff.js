// Utilitaires sans dépendance (navigateur + Node) : forme canonique et comparaison de versions.

export const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);

/** Blocs de premier niveau modifiés ou ajoutés par rapport à la version précédente (marqueur ☞ automatique). */
export function changedBlockIds(prev, cur) {
  const out = new Set();
  if (!prev || !cur?.body) return out;
  const before = new Map((prev.body || []).map((b) => [b.id, canonical(b)]));
  for (const b of cur.body) if (b.id && before.get(b.id) !== canonical(b)) out.add(b.id);
  return out;
}
