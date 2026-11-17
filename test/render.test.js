import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlocks, renderPrintHtml, renderScreenHtml, visaColumns, inline, frDate } from '../src/render.js';

const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

test('échappement HTML et mini-balisage', () => {
  assert.equal(inline('<b>x</b> **gras** __sou__'), '&lt;b&gt;x&lt;/b&gt; <b>gras</b> <u>sou</u>');
  assert.equal(inline('**a\nb**'), '<b>a\nb</b>');
});

test('numérotation automatique des listes : la numérotation d’origine fautive (1,2,3,4,3,5) est corrigée', () => {
  const html = renderBlocks([{ type: 'list', style: 'number', format: '{n}>', items: ['a', 'b', 'c', 'd', '~ suite', 'e', 'f'] }], {});
  assert.deepEqual([...html.matchAll(/class="mk">([^<]*)</g)].map((m) => m[1]), ['1>', '2>', '3>', '4>', '', '5>', '6>']);
});

test('numérotation des titres, sauf titres non numérotés', () => {
  const html = renderBlocks([{ type: 'heading', text: 'Rôle', numbered: false }, { type: 'heading', text: 'A' }, { type: 'heading', text: 'a1', level: 2 }, { type: 'heading', text: 'B' }], {});
  assert.match(html, /Rôle<\/h2>/); assert.match(html, /1\. A/); assert.match(html, /1\.1 a1/); assert.match(html, /2\. B/);
});

test('section répétable : instance > jeu > partagé, une instance par page', () => {
  const rep = { type: 'repeat', titleTemplate: 'T {title}', layout: [{ type: 'slot', slot: 'x' }, { type: 'slot', slot: 'y' }],
    shared: { x: [{ type: 'text', text: 'PARTAGE' }], y: [{ type: 'text', text: 'Y-PARTAGE' }] },
    presets: { P: { x: [{ type: 'text', text: 'JEU' }] } },
    instances: [{ title: 'un' }, { title: 'deux', preset: 'P' }, { title: 'trois', preset: 'P', slots: { x: [{ type: 'text', text: 'PROPRE' }] } }] };
  const html = renderBlocks([rep], {});
  assert.deepEqual([...html.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => m[1]), ['PARTAGE', 'Y-PARTAGE', 'JEU', 'Y-PARTAGE', 'PROPRE', 'Y-PARTAGE']);
  assert.equal((html.match(/class="rep newpage"/g) || []).length, 2);
  assert.match(html, /T trois/);
});

test('renvoi vers un document : résolu dans la GED, signalé s’il est introuvable', () => {
  const ctx = { docs: { 'K.1': { meta: { title: 'Audits', version: 4 } } } };
  assert.match(renderBlocks([{ type: 'docref', ref: 'K.1' }], ctx), /Audits \(v4\)/);
  assert.match(renderBlocks([{ type: 'docref', ref: 'K.9' }], ctx), /docref missing/);
});

test('cartouche : visas non signés = initiales + fonction de l’annuaire ; signés = fonction figée', () => {
  const doc = { workflow: { redacteur: 'A', examinateur: 'B', approbateur: 'C' }, meta: { version: 2, created: '2017-02-21', effective: '2025-01-28', service: 'Excelis', annule: { version: 1, date: '2017-02-21' } },
    visas: [{ role: 'examinateur', name: 'B', function: 'Ancien poste' }] };
  const cols = visaColumns(doc, { users: { B: { function: 'Nouveau poste' }, C: { function: 'Directeur' } } });
  assert.equal(cols[1][1], 'Ancien poste');           // figé
  assert.equal(cols[2][1], 'Directeur');              // pas encore visé : annuaire
  assert.deepEqual(cols[0], ['Création le 21/02/2017', 'Rédacteur Version 2 : A', 'Service émetteur :', 'Excelis']);
  assert.deepEqual(cols[2].slice(2), ['Annule version : 1', 'Du : 21/02/2017']);
  assert.equal(frDate('2025-01-28'), '28/01/2025');
});

const doc = (extra) => ({ kind: 'document', layout: { orientation: 'landscape' }, workflow: { redacteur: 'A', examinateur: 'B', approbateur: 'C' }, visas: [], body: [],
  meta: { ref: 'T.1', version: 3, society: 'LIS France', title: 'Titre "x"', created: '2026-01-01', dest: ['a'], keywords: ['k'] }, ...extra });

test('PDF : cartouche en boîtes de marge @page, paysage, visas en pied de page 1', () => {
  const html = renderPrintHtml(doc(), {});
  assert.match(html, /size:A4 landscape/); assert.match(html, /@top-right/); assert.match(html, /counter\(pages\)/);
  assert.match(html, /@page :first/); assert.match(html, /@bottom-left/); assert.match(html, /Réf : T\.1 +Vers : 3/);
});

test('annexe carte : N cartes par feuille, une feuille par face, verso en miroir, QR et mention non contrôlée', () => {
  const card = { kind: 'annex-card', workflow: {}, visas: [], meta: { ref: 'A.1', version: 2, society: 'S', title: 'CARTE', created: '2026-01-01', logo: '/l.jpg' },
    card: { faces: [{ id: 'recto', blocks: [] }, { id: 'verso', blocks: [] }] }, print: { perSheet: 2 } };
  const html = renderPrintHtml(card, { gedUrl: (r) => `http://ged/${r}`, qr: () => '<svg id="qr"></svg>' });
  assert.equal((html.match(/class="card"/g) || []).length, 4);   // 2 faces × 2 cartes
  assert.equal((html.match(/<section class="sheet /g) || []).length, 2);
  assert.match(html, /sgrid g2 cut"/); assert.match(html, /sgrid g2 cut mirror"/);
  assert.match(html, /<svg id="qr">/); assert.match(html, /non contrôlée/); assert.match(html, /A\.1&nbsp;&nbsp;\(2\)&nbsp;&nbsp;2 \/ 2/);
});

test('aperçu d’annexe dans un document : généré depuis l’annexe en vigueur, pas une image collée', () => {
  const annex = { card: { faces: [{ id: 'recto', blocks: [{ type: 'area', label: 'Problème ?' }] }] }, meta: { ref: 'A.9', version: 7, society: 'S', title: 'C', logo: '' } };
  const html = renderBlocks([{ type: 'annexpreview', ref: 'A.9' }], { docs: { 'A.9': annex } });
  assert.match(html, /Problème \?/); assert.match(html, /Annexe A\.9 \(v7\)/);
});

test('marque ☞ : éléments « ! » et blocs modifiés, avec gouttière réservée', () => {
  const body = [{ type: 'list', style: 'bullet', items: ['! nouveau', 'ancien'] }, { id: 'x', type: 'text', text: 'T' }];
  const html = renderPrintHtml(doc({ body }), { changed: new Set(['x']) });
  assert.match(html, /class="li chg"/); assert.match(html, /class="blk changed"/); assert.match(html, /content marks/);
});

test('aperçu écran : pas de crash sur un document vide', () => {
  assert.ok(renderScreenHtml(doc(), {}).includes('Réf : T.1'));
  assert.ok(text(renderScreenHtml(doc(), {})).length > 0);
});

test('renvoi [[REF]] dans un texte ou une liste : résolu dans la GED, signalé si introuvable', () => {
  const ctx = { docs: { 'K.1': { meta: { title: 'Audits 5S', version: 2 } } } };
  assert.match(renderBlocks([{ type: 'text', text: 'Cf. [[K.1]].' }], ctx), /Cf\. <span class="docref">K\.1 <i>– Audits 5S \(v2\)<\/i><\/span>\./);
  assert.match(renderBlocks([{ type: 'list', items: ['Voir [[K.9]]'] }], ctx), /docref missing/);
});
