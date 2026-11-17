// Workflow de visa interne : rédacteur → examinateur → approbateur.
// Un visa = enregistrement horodaté (nom ET fonction figés à la date du visa) + empreinte SHA-256 du contenu visé.
// Toute modification après visa est refusée : on ouvre une nouvelle version (indice).

import { createHash } from 'node:crypto';
import { canonical, changedBlockIds } from './diff.js';

export { changedBlockIds };

const STEPS = [
  { role: 'redacteur', from: 'brouillon', to: 'en_verification', label: 'Rédacteur' },
  { role: 'examinateur', from: 'en_verification', to: 'en_approbation', label: 'Examinateur' },
  { role: 'approbateur', from: 'en_approbation', to: 'en_vigueur', label: 'Approbateur' },
];

export class WorkflowError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

/** Empreinte du contenu : exclut ce que la GED pose APRÈS le visa (statut, visas, date d'effet, notes de migration). */
export function contentHash(doc) {
  const { effective, migration, ...meta } = doc.meta;
  const payload = { kind: doc.kind, layout: doc.layout, workflow: doc.workflow, meta, body: doc.body, card: doc.card, print: doc.print };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

export const today = () => new Date().toISOString().slice(0, 10);

export function nextStep(doc) {
  return STEPS.find((s) => s.from === doc.status) || null;
}

export function sign(doc, userId, users, date = today()) {
  const step = nextStep(doc);
  if (!step) throw new WorkflowError(`Aucun visa attendu au statut « ${doc.status} ».`);
  const expected = doc.workflow?.[step.role];
  if (!expected) throw new WorkflowError(`Aucun ${step.label.toLowerCase()} désigné pour ce document.`);
  if (expected !== userId) throw new WorkflowError(`Le visa « ${step.label} » est réservé à ${expected}.`, 403);
  const user = users[userId];
  if (!user) throw new WorkflowError(`Utilisateur inconnu : ${userId}`, 403);
  const next = structuredClone(doc);
  next.visas.push({ role: step.role, userId, name: user.name, function: user.function, date, hash: contentHash(doc) });
  next.status = step.to;
  if (step.to === 'en_vigueur') next.meta.effective = date;
  return next;
}

/** Vrai si le contenu actuel est bien celui qui a été visé. */
export function verifyIntegrity(doc) {
  const h = contentHash(doc);
  return (doc.visas || []).every((v) => v.hash === h);
}

const stripChangeFlags = (node) => {
  if (Array.isArray(node)) return node.forEach(stripChangeFlags);
  if (!node || typeof node !== 'object') return;
  if (node.type === 'list' && Array.isArray(node.items)) node.items = node.items.map((i) => (typeof i === 'string' ? i.replace(/^! /, '') : i));
  Object.values(node).forEach(stripChangeFlags);
};

/** Nouvelle version : repart en brouillon, annule la précédente à sa mise en vigueur. */
export function revise(doc, date = today()) {
  if (doc.status !== 'en_vigueur') throw new WorkflowError('Seule une version en vigueur peut être révisée.');
  const next = structuredClone(doc);
  next.meta.version = doc.meta.version + 1;
  next.meta.annule = { version: doc.meta.version, date: doc.meta.effective };
  next.meta.effective = null;
  next.meta.changeNote = '';
  next.status = 'brouillon';
  next.visas = [];
  stripChangeFlags(next.body);
  return next;
}
