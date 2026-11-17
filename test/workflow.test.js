import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, revise, verifyIntegrity, contentHash, changedBlockIds, nextStep, WorkflowError } from '../src/workflow.js';

const users = { CVE: { name: 'CVE', function: 'Service Excelis' }, DDE: { name: 'DDE', function: 'Directeur Qualité' }, FAR: { name: 'FAR', function: 'Directeur Général' } };
const draft = () => ({
  kind: 'document', status: 'brouillon', layout: { orientation: 'portrait' },
  workflow: { redacteur: 'CVE', examinateur: 'DDE', approbateur: 'FAR' },
  meta: { ref: 'T.01', version: 1, title: 'Test', created: '2026-01-01', effective: null, annule: null },
  visas: [], body: [{ id: 'a', type: 'text', text: 'un' }, { id: 'b', type: 'list', style: 'bullet', items: ['! point modifié', 'autre'] }],
});
const approved = () => ['CVE', 'DDE', 'FAR'].reduce((d, u) => sign(d, u, users, '2026-02-01'), draft());

test('le circuit suit rédacteur → examinateur → approbateur', () => {
  let d = draft();
  assert.equal(nextStep(d).role, 'redacteur');
  d = sign(d, 'CVE', users); assert.equal(d.status, 'en_verification');
  d = sign(d, 'DDE', users); assert.equal(d.status, 'en_approbation');
  d = sign(d, 'FAR', users, '2026-03-04');
  assert.equal(d.status, 'en_vigueur');
  assert.equal(d.meta.effective, '2026-03-04');
  assert.equal(nextStep(d), null);
});

test('un visa est refusé à un autre utilisateur ou dans le mauvais ordre', () => {
  assert.throws(() => sign(draft(), 'FAR', users), (e) => e instanceof WorkflowError && e.status === 403);
  assert.throws(() => sign(approved(), 'FAR', users), WorkflowError);
});

test('le visa fige la fonction : un changement d’annuaire ne réécrit pas le passé', () => {
  const d = approved();
  const later = { ...users, FAR: { name: 'FAR', function: 'Président' } };
  assert.equal(d.visas.find((v) => v.userId === 'FAR').function, 'Directeur Général');
  assert.equal(later.FAR.function, 'Président'); // l'annuaire change, le visa non
});

test('l’empreinte détecte toute modification après visa', () => {
  const d = approved();
  assert.ok(verifyIntegrity(d));
  const tampered = structuredClone(d); tampered.body[0].text = 'deux';
  assert.equal(verifyIntegrity(tampered), false);
});

test('l’empreinte ignore ce que la GED pose après le visa (statut, date d’effet)', () => {
  const d = draft(); const h = contentHash(d);
  const e = structuredClone(d); e.status = 'en_vigueur'; e.meta.effective = '2030-01-01'; e.visas.push({});
  assert.equal(contentHash(e), h);
});

test('nouvelle version : brouillon, visas vidés, version précédente référencée, marques ! retirées', () => {
  const v2 = revise(approved());
  assert.equal(v2.meta.version, 2); assert.equal(v2.status, 'brouillon'); assert.deepEqual(v2.visas, []);
  assert.deepEqual(v2.meta.annule, { version: 1, date: '2026-02-01' });
  assert.equal(v2.meta.effective, null);
  assert.equal(v2.body[1].items[0], 'point modifié');
  assert.throws(() => revise(draft()), WorkflowError);
});

test('diff automatique : seuls les blocs modifiés ou ajoutés sont marqués ☞', () => {
  const v1 = approved(); const v2 = revise(v1);
  assert.equal(changedBlockIds(v1, v2).size, 1); // le « ! » retiré modifie le bloc b
  v2.body[0].text = 'modifié'; v2.body.push({ id: 'c', type: 'text', text: 'nouveau' });
  assert.deepEqual([...changedBlockIds(v1, v2)].sort(), ['a', 'b', 'c']);
});

test('diff des sections répétables : par instance, sur le contenu effectif (pas le JSON brut)', async () => {
  const { changedInstances } = await import('../src/diff.js');
  const T = (t) => [{ type: 'text', text: t }];
  const rep = (over = {}, extra = []) => ({ id: 'r', type: 'repeat', shared: { a: T('commun') }, presets: { P: { a: T('jeu') } },
    instances: [{ title: 'un' }, { title: 'deux', preset: 'P' }, { title: 'trois', slots: { a: T('propre') } }, ...extra], ...over });
  const v1 = { body: [rep()] };
  assert.equal(changedInstances(v1, { body: [rep()] }).size, 0);
  // modifier le contenu partagé : seules les instances qui le suivent (« un ») changent
  assert.deepEqual([...changedInstances(v1, { body: [rep({ shared: { a: T('nouveau') } })] })], ['r::un']);
  // modifier le jeu P : « deux » ; une instance ajoutée est marquée
  assert.deepEqual([...changedInstances(v1, { body: [rep({ presets: { P: { a: T('autre') } } }, [{ title: 'quatre' }])] })].sort(), ['r::deux', 'r::quatre']);
  // les ids de blocs n'influencent pas la comparaison
  const withId = { body: [rep({ shared: { a: [{ id: 'z', type: 'text', text: 'commun' }] } })] };
  assert.equal(changedInstances(v1, withId).size, 0);
});
