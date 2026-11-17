// Lecture XML minimale : arbre {tag, attrs, children, text} à partir de fast-xml-parser (ordre préservé).
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: true });

function build(nodes) {
  const out = [];
  for (const n of nodes) {
    const key = Object.keys(n).find((k) => k !== ':@');
    if (key === '#text') { out.push({ tag: '#text', text: String(n['#text']), attrs: {}, children: [] }); continue; }
    if (key.startsWith('?')) continue;
    out.push({ tag: key, attrs: n[':@'] || {}, children: build(n[key] || []) });
  }
  return out;
}

export const parseXml = (xml) => ({ tag: '#root', attrs: {}, children: build(parser.parse(xml)) });

const local = (t) => t.replace(/^.*:/, '');
/** Enfants directs portant ce nom local (préfixe d'espace de noms ignoré). */
export const kids = (n, name) => (n?.children || []).filter((c) => local(c.tag) === name);
export const kid = (n, name) => kids(n, name)[0];
/** Descendant par chemin de noms locaux : path(n, 'tcPr', 'gridSpan'). */
export const path = (n, ...names) => names.reduce((a, nm) => (a ? kid(a, nm) : undefined), n);
export const attr = (n, name) => n?.attrs?.[name] ?? n?.attrs?.[`w:${name}`];
/** Tous les descendants de ce nom (sans traverser mc:Fallback : repli VML qui duplique le contenu). */
export function all(n, name, out = []) {
  for (const c of n?.children || []) {
    if (local(c.tag) === 'Fallback') continue;
    if (local(c.tag) === name) out.push(c);
    all(c, name, out);
  }
  return out;
}
export const tagName = local;
