// Écrit les documents pilotes dans data/documents/<REF>/v<N>.json (sans écraser l'existant, sauf --force).
import { mkdir, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withIds } from './helpers.js';
import { users } from './users.js';
import { contentHash } from '../src/workflow.js';
import k100 from './k08100.js';
import k104 from './k08104.js';
import k111 from './k08111.js';
import a134 from './a134.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const exists = (p) => access(p).then(() => true, () => false);

// Documents migrés « en vigueur » : les visas d'origine sont reconstitués avec la fonction de l'époque.
const SNAPSHOT_FUNCTIONS = {
  'K.08.100': { GVN: 'Amélioration Continue', FAR: 'Responsable Technique', ADP: 'Responsable Qualité' },
  'K.08.104': { CVE: 'Service Excelis', FBU: 'Directeur Technique', DDE: 'Directeur Qualité' },
  'K.08.111': { CVE: 'Service Excelis', DDE: 'Directeur Qualité', FAR: 'Directeur Général' },
};

function migratedVisas(doc) {
  const hash = contentHash(doc);
  const fn = SNAPSHOT_FUNCTIONS[doc.meta.ref];
  return ['redacteur', 'examinateur', 'approbateur'].map((role) => {
    const id = doc.workflow[role];
    return { role, userId: id, name: id, function: fn[id], date: doc.meta.effective, hash, origin: 'migration' };
  });
}

export async function seed({ force = false } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'users.json'), JSON.stringify(users, null, 2));
  const created = [];
  // Documents issus de la migration Word → JSON (tools/migrate), déjà complets (ids, visas historiques).
  const migDir = join(dirname(fileURLToPath(import.meta.url)), 'migrated');
  const migrated = [];
  for (const ref of await readdir(migDir).catch(() => [])) for (const f of await readdir(join(migDir, ref))) migrated.push(JSON.parse(await readFile(join(migDir, ref, f), 'utf8')));
  for (const raw of [k111, k100, k104, a134]) {
    const doc = withIds(structuredClone(raw));
    if (doc.status === 'en_vigueur') doc.visas = migratedVisas(doc);
    const dir = join(root, 'documents', doc.meta.ref);
    const file = join(dir, `v${doc.meta.version}.json`);
    if (!force && (await exists(file))) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(doc, null, 2));
    created.push(`${doc.meta.ref} v${doc.meta.version}`);
  }
  for (const doc of migrated) {
    const dir = join(root, 'documents', doc.meta.ref);
    const file = join(dir, `v${doc.meta.version}.json`);
    if (!force && (await exists(file))) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(doc, null, 2));
    created.push(`${doc.meta.ref} v${doc.meta.version} (migré)`);
  }
  return created;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = await seed({ force: process.argv.includes('--force') });
  console.log(c.length ? `Créés : ${c.join(', ')}` : 'Rien à faire (données déjà présentes ; --force pour réinitialiser).');
}
