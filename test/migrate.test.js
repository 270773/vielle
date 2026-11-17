import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { convertDocx } from '../tools/migrate/docx.js';

// ───── fabrique de .docx minimaux ─────
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const run = (t, o = {}) => `<w:r>${o.b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const ptxt = (t, o) => p(run(t, o));
const li = (t, numId = 1, o) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(t, o)}</w:p>`;
const tc = (inner, w = 4000, span) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>${inner}</w:tc>`;
const tr = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
const tbl = (grid, ...rows) => `<w:tbl><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
const png = (w, h) => { const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const inlineImg = (rid, cx, cy) => `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const ellipse = (x, y, cx, cy, text) => `<w:r><mc:AlternateContent><mc:Choice><w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="${text ? 'rect' : 'ellipse'}"/><a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></wps:spPr>${text ? `<wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>` : ''}</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:oval/></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;

async function makeDocx({ body, header, footer, numbering, media = {} }) {
  const z = new JSZip();
  z.file('word/document.xml', `<?xml version="1.0"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  z.file('word/_rels/document.xml.rels', `<Relationships>${Object.keys(media).map((k) => `<Relationship Id="${k}" Target="media/${k}.png"/>`).join('')}</Relationships>`);
  for (const [k, v] of Object.entries(media)) z.file(`word/media/${k}.png`, v);
  if (header) z.file('word/header2.xml', `<?xml version="1.0"?><w:hdr ${NS}>${header}</w:hdr>`);
  if (footer) z.file('word/footer1.xml', `<?xml version="1.0"?><w:ftr ${NS}>${footer}</w:ftr>`);
  z.file('word/numbering.xml', numbering || `<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const cell = (...lines) => tc(lines.map((l) => ptxt(l)).join(''));

// En-têtes : 4 cellules (« Réf : K.08.11 » + « 1 » dans des runs séparés) ou 7 cellules éclatées
const HEAD_COMPACT = tbl([3000, 3000], tr(cell('LIS France'), tc(p(run('Réf : K.08.11'), run('1')) + ptxt('Vers : 2')), cell('Page : 1 / 2')), tr(cell('Dest : Salle A / Resp. B'), cell('Mots-clés : Audit / Tablette')), tr(tc(ptxt('MODE OPÉRATOIRE :') + ptxt('RÉALISATION D’UN AUDIT', { b: true }), 9000, 2)));
const HEAD_SPLIT = tbl([1000], tr(cell('LIS France'), cell('Réf. :'), cell('K.08.111'), cell('Ver. :'), cell('2'), cell('Page :'), cell('1 / 2')), tr(cell('Dest. :'), cell('Salle A / Resp. B'), cell('Mots-clés :'), cell('Audit / Tablette')), tr(cell('MODE OPÉRATOIRE :'), cell('RÉALISATION D’UN AUDIT')));
// Pieds de page : 2 lignes × 3 colonnes (valeur sous le libellé) ou 4 lignes éclatées
const FOOT_2x3 = tbl([3000], tr(cell('Création le 16 / 06 /202 2', 'Rédacteur Version 2 : GVN'), cell('Examinateur : DSY', 'Responsable Séchages'), cell('Approbateur : FAR', 'Directeur Technique')), tr(cell('Service émetteur :', 'Excelis'), cell('Effective le :', '17/06/2022'), cell('Annule version : 1', 'Du : 16/06/2022')));
const FOOT_4x = tbl([3000], tr(cell('Création le 16/06/2022'), cell('Examinateurs :'), cell('DSY'), cell('Approbateur :'), cell('FAR')), tr(cell('Rédacteur Version 2 : GVN'), cell('Responsable Séchages'), cell('Directeur Technique')), tr(cell('Service émetteur :'), cell('Effective le :'), cell('Annule version :'), cell('1')), tr(cell('Excelis'), cell('17/06/2022'), cell(''), cell('16/06/2022')));

for (const [name, header, footer] of [['en-tête compact + pied 2×3', HEAD_COMPACT, FOOT_2x3], ['en-tête éclaté + pied 4 lignes', HEAD_SPLIT, FOOT_4x]]) {
  test(`cartouche lu par libellés : ${name}`, async () => {
    const { doc, report } = await convertDocx(await makeDocx({ body: ptxt('x'), header, footer }), { source: 'x.docx' });
    const m = doc.meta;
    assert.match(m.ref, /^K\.08\.11[1]$/); assert.equal(m.version, 2); assert.equal(m.society, 'LIS France');
    assert.deepEqual(m.dest, ['Salle A', 'Resp. B']); assert.deepEqual(m.keywords, ['Audit', 'Tablette']);
    assert.match(m.title, /^MODE OPÉRATOIRE : RÉALISATION D’UN AUDIT$/); // titre sur 2 paragraphes
    assert.equal(m.created, '2022-06-16'); assert.equal(m.effective, '2022-06-17'); assert.equal(m.service, 'Excelis');
    assert.deepEqual(m.annule, { version: 1, date: '2022-06-16' });
    assert.deepEqual(doc.workflow, { redacteur: 'GVN', examinateur: 'DSY', approbateur: 'FAR' });
    assert.deepEqual(m.migration.legacy.map((v) => [v.userId, v.function]), [['GVN', ''], ['DSY', 'Responsable Séchages'], ['FAR', 'Directeur Technique']]);
    assert.ok(!report.flags.some((f) => /Cartouche/.test(f.message)));
  });
}

test('sans en-tête Word : référence et version déduites du nom de fichier, avec réserve', async () => {
  const { doc, report } = await convertDocx(await makeDocx({ body: ptxt('x') }), { source: 'A134-3.doc' });
  assert.equal(doc.meta.ref, 'A.134'); assert.equal(doc.meta.version, 3);
  assert.ok(report.flags.some((f) => /déduites du nom du fichier/.test(f.message)));
  const k = await convertDocx(await makeDocx({ body: ptxt('x') }), { source: 'K08104-2.doc' });
  assert.equal(k.doc.meta.ref, 'K.08.104');
});

test('listes : numérotées / à puces, fusion à travers les lignes d’un tableau de mise en page', async () => {
  const body = tbl([500, 6000], tr(tc('<w:p/>', 500), tc(li('un') + '<w:p/>' + li('deux'), 6000)), tr(tc('<w:p/>', 500), tc(li('trois'), 6000)))
    + li('puce', 2) + li('puce 2', 2);
  const { doc } = await convertDocx(await makeDocx({ body }), { source: 'x.docx' });
  assert.deepEqual(doc.body.map((b) => [b.type, b.style, b.items?.length]), [['list', 'number', 3], ['list', 'bullet', 2]]);
});

test('☞ isolé dans la colonne de marge → élément en gras de la même ligne marqué « modifié »', async () => {
  const body = tbl([500, 6000], tr(tc(ptxt('☞'), 500), tc(li('ancien') + li('nouveau', 1, { b: true }), 6000)));
  const { doc } = await convertDocx(await makeDocx({ body }), { source: 'x.docx' });
  assert.deepEqual(doc.body[0].items, ['ancien', '! **nouveau**']);
});

test('lignes « LIBELLÉ : valeur » séparées par des paragraphes vides → fiche clé/valeur ; titre gras → titre', async () => {
  const body = ptxt('OBJECTIFS :', { b: true }) + ['QUOI : cartes', 'LIEU : panneau', 'QUI : tous'].map((t) => ptxt(t) + '<w:p/>').join('');
  const { doc } = await convertDocx(await makeDocx({ body }), { source: 'x.docx' });
  assert.equal(doc.body[0].type, 'heading');
  assert.deepEqual(doc.body[1], { type: 'keyvalue', bordered: false, rows: [['QUOI :', 'cartes'], ['LIEU :', 'panneau'], ['QUI :', 'tous']], id: doc.body[1].id });
});

test('tableau d’étapes : sections, numérotation discontinue signalée, annotations en % de l’image', async () => {
  const IMG = { cx: 2000000, cy: 1000000 };
  const stepRow = (n, text, extra = '') => tr(tc(ptxt(n), 500), tc(ptxt(text), 4000), tc(p(inlineImg('img1', IMG.cx, IMG.cy), extra), 4000));
  const body = tbl([500, 4000, 4000], tr(tc(ptxt('N°', { b: true }), 500), tc(ptxt('Opérations', { b: true }), 8000, 2)),
    tr(tc(ptxt('Avant', { b: true }), 8500, 3)), stepRow('1', 'Ouvrir', ellipse(500000, 250000, 400000, 200000) + ellipse(100000, 100000, 100000, 100000, '1')),
    tr(tc(ptxt('Pendant', { b: true }), 8500, 3)), stepRow('3', 'Cliquer'));
  const { doc, report, assets } = await convertDocx(await makeDocx({ body, media: { img1: png(800, 400) } }), { source: 'x.docx', assetBase: '/a/b' });
  const steps = doc.body[0];
  assert.equal(steps.type, 'steps'); assert.deepEqual(steps.sections.map((s) => [s.title, s.steps.length]), [['Avant', 1], ['Pendant', 1]]);
  assert.equal(steps.sections[0].steps[0].image.src, '/a/b/img1.png'); assert.equal(assets.length, 1);
  const [oval, label] = steps.sections[0].steps[0].image.annotations;
  assert.deepEqual([oval.shape, oval.x, oval.y, oval.w, oval.h, oval.color], ['ellipse', 25, 25, 20, 20, '#FF0000']);
  assert.deepEqual([label.shape, label.text], ['label', '1']);
  assert.ok(report.flags.some((f) => /discontinue \(1, 3\)/.test(f.message)));
  assert.equal(report.counts.ignoredTextBoxes, 0); // l'étiquette est convertie, pas ignorée
});

test('grande image PNG : signalée comme texte probablement non converti', async () => {
  const body = p(inlineImg('img1', 5000000, 2500000));
  const { report } = await convertDocx(await makeDocx({ body, media: { img1: png(1230, 640) } }), { source: 'x.docx' });
  assert.equal(report.counts.imagesProbablyText, 1);
  assert.ok(report.flags.some((f) => f.level === 'todo' && /n'est PAS converti/.test(f.message)));
});
