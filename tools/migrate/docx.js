// Conversion d'un document Word (.docx) vers le format JSON de la GED.
//
// Principe : on convertit ce qui est STRUCTURÉ dans le Word (cartouche d'en-tête/pied de page, paragraphes, listes,
// tableaux, images, formes d'annotation) et on SIGNALE ce qui ne l'est pas (texte contenu dans des images, zones de
// texte, formulaires dessinés). Le rapport quantifie les deux : rien n'est perdu sans être listé.

import JSZip from 'jszip';
import { parseXml, kids, kid, path, attr, all, tagName } from './xml.js';

const TW = 635; // EMU par twip

// Symboles de police (Wingdings, Webdings…) que le Word utilise pour des marques ou des cases.
const SYMBOLS = { 'wingdings:f046': '☞', 'wingdings 2:f03f': '☞', 'wingdings:f0fc': '✓', 'wingdings:f0a8': '☐', 'webdings:f063': '☐' };
const sym = (font, ch) => SYMBOLS[`${String(font).toLowerCase()}:${String(ch).toLowerCase()}`] ?? '☐';
const onOff = (n) => !!n && !['0', 'false', 'off'].includes(String(attr(n, 'val') ?? '1').toLowerCase());
const ratio = (segs, k) => { const ch = (x) => x.t.replace(/\s/g, '').length; const tot = segs.reduce((a, x) => a + ch(x), 0); return tot ? segs.filter((x) => x[k]).reduce((a, x) => a + ch(x), 0) / tot : 0; };
const plainOf = (s) => String(s).replace(/\*\*|__/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// ───────────── lecture bas niveau ─────────────

function runSegments(p) {
  const segs = [];
  const run = (r) => {
    const rPr = kid(r, 'rPr');
    const b = onOff(kid(rPr, 'b'));
    const uN = kid(rPr, 'u'); const u = !!uN && String(attr(uN, 'val')) !== 'none';
    let t = '';
    for (const c of r.children) {
      switch (tagName(c.tag)) {
        case 't': t += c.children.map((x) => x.text ?? '').join(''); break;
        case 'tab': t += ' '; break;
        case 'br': if (!['page', 'column'].includes(attr(c, 'type'))) t += '\n'; break;
        case 'noBreakHyphen': t += '-'; break;
        case 'sym': t += sym(attr(c, 'font'), attr(c, 'char')); break;
        default: break;
      }
    }
    if (t) segs.push({ t, b, u });
  };
  const walk = (n) => {
    for (const c of n.children) {
      const tn = tagName(c.tag);
      if (tn === 'r') run(c);
      else if (['hyperlink', 'ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple'].includes(tn)) walk(c);
      else if (tn === 'AlternateContent') { /* contenu graphique : traité à part */ }
    }
  };
  walk(p);
  return segs;
}

function toMarkup(segs) {
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.b === s.b && last.u === s.u) last.t += s.t; else merged.push({ ...s });
  }
  return merged.map(({ t, b, u }) => {
    const core = t.trim();
    if (!core || (!b && !u)) return t;
    const lead = t.slice(0, t.length - t.trimStart().length), trail = t.slice(t.trimEnd().length);
    let m = core.replace(/\n/g, `${b ? '**' : ''}${u ? '__' : ''}\n${u ? '__' : ''}${b ? '**' : ''}`);
    if (b) m = `**${m}**`; if (u) m = `__${m}__`;
    return lead + m + trail;
  }).join('');
}

function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), fmt: 'jpeg' };
      i += 2 + len;
    }
  }
  return { w: 0, h: 0, fmt: '?' };
}

const normDate = (s) => {
  const m = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*((?:\d\s*){4})/.exec(s || ''); // tolère « 16 / 06 /202 2 » (runs éclatés)
  return m ? `${m[3].replace(/\s/g, '')}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

// ───────────── convertisseur ─────────────

export async function convertDocx(buffer, { source = 'document.docx', assetBase = '/assets/migrated' } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (n) => (zip.file(n) ? zip.file(n).async('string') : null);
  const root = parseXml(await read('word/document.xml'));
  const body = path(kid(root, 'document'), 'body');

  // relations (images) et numérotation
  const rels = {};
  for (const r of all(parseXml((await read('word/_rels/document.xml.rels')) || '<x/>'), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target;
  const numbering = parseNumbering(await read('word/numbering.xml'));

  const report = { source, flags: [], counts: { paragraphs: 0, textChars: 0, lists: 0, tables: 0, stepsTables: 0, layoutTables: 0, images: 0, imagesProbablyText: 0, annotations: 0, ignoredTextBoxes: 0, ignoredShapes: 0 }, blocks: {} };
  const flag = (level, message) => report.flags.push({ level, message });
  const assets = new Map();

  async function imageFor(rid) {
    const target = rels[rid]; if (!target) return null;
    const file = target.replace(/^\/?(word\/)?/, 'word/');
    const z = zip.file(file); if (!z) return null;
    const name = file.split('/').pop();
    if (!assets.has(name)) {
      const data = await z.async('nodebuffer');
      const size = imageSize(data);
      assets.set(name, { name, data, ...size });
      report.counts.images++;
      if (size.w >= 900 && size.h >= 400 && size.fmt === 'png') {
        report.counts.imagesProbablyText++;
        flag('todo', `Image ${name} (${size.w}×${size.h}) : grande capture/grille probablement textuelle (copie collée d'un tableau Excel ?). Le texte qu'elle contient n'est PAS converti : à retranscrire (saisie, OCR ou transcription assistée).`);
      }
    }
    return { src: `${assetBase}/${name}`, asset: assets.get(name) };
  }

  // ── paragraphes ──
  async function paraInfo(p, cell) {
    const segs = runSegments(p);
    let markup = toMarkup(segs).replace(/\n+$/, '');
    // marque ☞ de début de paragraphe → « modifié dans cette version »
    let changed = false;
    if (/^\s*(\*\*)?☞\s*\S/.test(markup)) { changed = true; markup = markup.replace(/☞\s*/, ''); }
    const plain = plainOf(markup);
    const pPr = kid(p, 'pPr');
    const numPr = path(pPr, 'numPr');
    const info = {
      markup, plain, changed,
      allBold: ratio(segs, 'b') >= 0.8,
      allUnder: ratio(segs, 'u') >= 0.8,
      num: numPr ? { id: attr(kid(numPr, 'numId'), 'val'), lvl: Number(attr(kid(numPr, 'ilvl'), 'val') || 0) } : null,
      jc: attr(path(pPr, 'jc'), 'val'), images: [], shapes: [],
    };
    for (const d of all(p, 'drawing')) {
      const inl = kid(d, 'inline'), anc = kid(d, 'anchor'), host = inl || anc;
      if (!host) continue;
      const ext = kid(host, 'extent'); const cx = Number(ext?.attrs.cx || 0), cy = Number(ext?.attrs.cy || 0);
      const blip = all(host, 'blip')[0];
      if (blip) {
        const img = await imageFor(blip.attrs['r:embed']);
        if (img) info.images.push({ ...img, cx, cy, floating: !!anc });
      } else if (anc) {
        const wsp = all(anc, 'wsp')[0]; if (!wsp) { report.counts.ignoredShapes++; continue; }
        const ph = kid(anc, 'positionH'), pv = kid(anc, 'positionV');
        const geom = attr(path(wsp, 'spPr', 'prstGeom'), 'prst');
        const line = path(wsp, 'spPr', 'ln'); const color = attr(path(line, 'solidFill', 'srgbClr'), 'val');
        info.shapes.push({
          geom, text: all(wsp, 't').map((t) => t.children.map((x) => x.text ?? '').join('')).join('').trim(), color: color ? `#${color}` : '#ff0000',
          cx, cy, offH: Number(kid(ph, 'posOffset')?.children[0]?.text ?? 0), offV: Number(kid(pv, 'posOffset')?.children[0]?.text ?? 0),
          relH: attr(ph, 'relativeFrom'), relV: attr(pv, 'relativeFrom'),
        });
      }
    }
    // zones de texte non reprises = celles qui ne sont pas des étiquettes d'annotation converties
    report.counts.ignoredTextBoxes += Math.max(0, all(p, 'txbxContent').length - info.shapes.filter((x) => x.text).length);
    info.hasAnchoredText = false;
    report.counts.paragraphs++;
    report.counts.textChars += plain.length;
    return info;
  }

  const KV = /^(\p{Lu}[\p{Lu}'’ ]{1,14}?)\s*:\s*(.+)$/u;
  const heading = (i) => !i.num && i.allBold && i.plain && i.plain.length <= 90 && !/[.;]$/.test(i.plain) && (/:$/.test(i.plain) || i.allUnder || i.plain === i.plain.toUpperCase());
  const tidyTitle = (s) => s.replace(/\s+:/, ' :').replace(/\s+$/, '');

  /** Liste d'infos de paragraphes → blocs. */
  function assemble(raw) {
    const infos = []; let mark = false;
    for (const i of raw) { // un ☞ isolé dans son paragraphe marque l'élément qui suit (« modifié dans cette version »)
      if (i.plain === '☞') { mark = true; continue; }
      if (mark && i.plain) { i.changed = true; mark = false; }
      infos.push(i);
    }
    const out = []; let text = [], list = null;
    const flushText = () => {
      if (!text.length) return;
      const rows = text.map((t) => KV.exec(plainOf(t)));
      if (text.length >= 3 && rows.every(Boolean)) out.push({ type: 'keyvalue', bordered: false, rows: text.map((t) => { const m = KV.exec(plainOf(t)); return [`${m[1].trim()} :`, m[2].trim()]; }) });
      else out.push({ type: 'text', text: text.join('\n') });
      text = [];
    };
    const flushList = () => { if (list) { out.push(list); report.counts.lists++; list = null; } };
    for (const i of infos) {
      if (i.images.length) { flushText(); flushList(); for (const im of i.images.filter((x) => !x.floating)) out.push({ type: 'image', src: im.src, width: '100%', _asset: im.asset }); if (!i.plain) continue; }
      if (!i.plain) { flushText(); continue; } // paragraphe vide = espacement : ferme le texte, pas la liste
      if (i.num) {
        flushText();
        const li = listInfo(numbering, i.num.id, i.num.lvl);
        const key = `${li.style}|${li.format}|${i.num.lvl > 0}`;
        if (!list || list._key !== key) { flushList(); list = { type: 'list', style: li.style, ...(li.style === 'number' ? { format: li.format } : {}), ...(i.num.lvl > 0 ? { nested: true } : {}), items: [], _key: key }; }
        list.items.push(`${i.changed ? '! ' : ''}${i.markup}`);
        continue;
      }
      flushList();
      if (heading(i)) { flushText(); out.push({ type: 'heading', text: tidyTitle(i.plain), level: 1, numbered: false }); continue; }
      text.push(i.changed ? `☞ ${i.markup}` : i.markup);
    }
    flushText(); flushList();
    for (const b of out) delete b._key;
    // lignes « LIBELLÉ : valeur » séparées par des paragraphes vides → une seule fiche clé/valeur
    const merged = []; let run = [];
    const kvOf = (b) => b.type === 'text' && !b.text.includes('\n') && KV.exec(plainOf(b.text));
    const endRun = () => { if (run.length >= 3) merged.push({ type: 'keyvalue', bordered: false, rows: run.map((b) => { const m = KV.exec(plainOf(b.text)); return [`${m[1].trim()} :`, m[2].trim()]; }) }); else merged.push(...run); run = []; };
    for (const b of out) { if (kvOf(b)) run.push(b); else { endRun(); merged.push(b); } }
    endRun();
    return merged;
  }

  /** Listes consécutives de même style (coupées par des lignes de tableau de mise en page) → une seule liste. */
  const mergeLists = (blocks) => blocks.reduce((acc, b) => {
    const last = acc[acc.length - 1];
    if (last?.type === 'list' && b.type === 'list' && last.style === b.style && last.format === b.format && !!last.nested === !!b.nested) last.items.push(...b.items);
    else acc.push(b);
    return acc;
  }, []);

  // ── conteneurs (corps, cellules) ──
  async function container(children) {
    const infos = []; const blocks = [];
    const drain = () => { blocks.push(...assemble(infos.splice(0))); };
    for (const c of children) {
      const tn = tagName(c.tag);
      if (tn === 'p') infos.push(await paraInfo(c));
      else if (tn === 'tbl') { drain(); blocks.push(...(await table(c))); }
      else if (tn === 'sdt') { const content = kid(c, 'sdtContent'); if (content) { drain(); blocks.push(...(await container(content.children))); } }
    }
    drain();
    return mergeLists(blocks);
  }

  const cellsOf = (row) => kids(row, 'tc').map((tc) => ({ tc, span: Number(attr(path(tc, 'tcPr', 'gridSpan'), 'val') || 1), w: Number(attr(path(tc, 'tcPr', 'tcW'), 'w') || 0) }));
  const cellPlain = (tc) => kids(tc, 'p').map((p) => plainOf(toMarkup(runSegments(p)))).join('\n').trim();

  async function table(tbl) {
    report.counts.tables++;
    const rows = kids(tbl, 'tr');
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Number(g.attrs.w || attr(g, 'w') || 0));
    const first = rows[0] ? cellsOf(rows[0]).map((c) => cellPlain(c.tc)) : [];
    if (first.length && /^N\s*°$/i.test(first[0]) && rows.length >= 3) return [await stepsTable(rows, grid)];
    // tableau de données simple ?
    const cells = rows.map(cellsOf);
    const n = cells[0]?.length || 0;
    const simple = rows.length >= 2 && n >= 2 && n <= 6 && cells.every((r) => r.length === n && r.every((c) => c.span === 1)) &&
      cells.flat().every((c) => all(c.tc, 'drawing').length === 0 && all(c.tc, 'numPr').length === 0 && kids(c.tc, 'p').length <= 2) && cells.flat().some((c) => cellPlain(c.tc));
    if (simple) {
      const hdrBold = cells[0].every((c) => all(c.tc, 'b').length > 0);
      const data = cells.map((r) => r.map((c) => cellPlain(c.tc)));
      return [{ type: 'table', headers: hdrBold ? data[0] : [], rows: hdrBold ? data.slice(1) : data }];
    }
    // sinon : tableau de mise en page → on aplatit, colonnes côte à côte si plusieurs cellules non vides
    report.counts.layoutTables++;
    const out = [];
    for (const r of cells) {
      const parts = [];
      // ☞ placés dans la colonne de marge, alignés à la main avec les éléments modifiés (en gras)
      const marks = r.reduce((n, c) => n + kids(c.tc, 'p').filter((p) => plainOf(toMarkup(runSegments(p))) === '☞').length, 0);
      for (const c of r) { const blocks = await container(c.tc.children); if (blocks.length) parts.push({ blocks, w: c.w }); }
      if (marks) {
        const lists = parts.flatMap((p) => p.blocks).filter((b) => b.type === 'list');
        const boldItem = (it) => /^\*\*[\s\S]*\*\*$/.test(it);
        const nBold = lists.reduce((n, l) => n + l.items.filter(boldItem).length, 0);
        if (nBold === marks) { for (const l of lists) l.items = l.items.map((it) => (boldItem(it) ? `! ${it}` : it)); report.counts.changeMarks = (report.counts.changeMarks || 0) + marks; }
        else flag('warn', `${marks} marque(s) ☞ « modifié dans cette version » non rattachée(s) à un élément de texte (${nBold} élément(s) en gras dans la même ligne) : à reporter à la main.`);
      }
      if (parts.length === 1) out.push(...parts[0].blocks);
      else if (parts.length > 1) out.push({ type: 'columns', widths: parts.map((p) => Math.max(1, Math.round((p.w || 1) / 100) / 10)), cells: parts.map((p) => p.blocks) });
    }
    return mergeLists(out);
  }

  // ── tableau d'étapes numérotées avec captures annotées (type K.08.110) ──
  async function stepsTable(rows, grid) {
    report.counts.stepsTables++;
    const sections = []; let cur = null; const numbers = [];
    const hdr = cellsOf(rows[0]).map((c) => cellPlain(c.tc));
    for (const row of rows.slice(1)) {
      const cs = cellsOf(row);
      if (cs.length === 1 || cs[0].span >= 2) { cur = { title: tidyTitle(cellPlain(cs[0].tc)), steps: [] }; sections.push(cur); continue; }
      if (!cur) { cur = { title: '', steps: [] }; sections.push(cur); }
      const num = cellPlain(cs[0].tc);
      numbers.push(Number(num) || null);
      const textInfos = [];
      for (const p of kids(cs[1].tc, 'p')) textInfos.push(await paraInfo(p));
      const lines = textInfos.filter((i) => i.plain).map((i) => (i.num ? `- ${i.markup}` : i.markup));
      const step = { text: lines.join('\n') };
      if (cs[2]) {
        const imgInfos = []; for (const p of kids(cs[2].tc, 'p')) imgInfos.push(await paraInfo(p));
        const img = imgInfos.flatMap((i) => i.images)[0];
        if (img) {
          step.image = { src: img.src, annotations: [] };
          const colIdx = cs.slice(0, 2).reduce((a, c) => a + c.span, 0);
          const cellW = (grid[colIdx] || cs[2].w || 4000);
          const centered = imgInfos.some((i) => i.images.length && i.jc === 'center');
          for (const sh of imgInfos.flatMap((i) => i.shapes)) {
            const a = annotation(sh, img, cellW, centered);
            if (a) { step.image.annotations.push(a); report.counts.annotations++; }
          }
          step._asset = img.asset;
        }
      }
      cur.steps.push(step);
    }
    const gaps = numbers.filter((n, i) => i > 0 && n && numbers[i - 1] && n !== numbers[i - 1] + 1);
    if (gaps.length) flag('warn', `Numérotation d'origine discontinue (${numbers.join(', ')}) : renumérotée 1 à ${numbers.length} automatiquement. Vérifier les renvois internes éventuels.`);
    return { type: 'steps', headers: hdr.length === 2 ? [hdr[0], hdr[1], ''] : hdr, sections };
  }

  /** Forme ancrée (cercle, étiquette…) → annotation relative à l'image, en % de ses dimensions. */
  function annotation(sh, img, cellWTw, centered) {
    const okH = ['column', 'character'].includes(sh.relH), okV = ['paragraph', 'line', 'character'].includes(sh.relV);
    if (!okH || !okV || !img.cx || !img.cy) { flag('warn', `Forme « ${sh.geom} » positionnée par rapport à « ${sh.relH}/${sh.relV} » : position non convertie.`); report.counts.ignoredShapes++; return null; }
    const content = (cellWTw - 216) * TW; // marges de cellule par défaut : 108 twips de chaque côté
    const left = centered ? (content - img.cx) / 2 : 0;
    const r = (v) => Math.round(v * 1000) / 10;
    const base = { x: r((sh.offH - left) / img.cx), y: r(sh.offV / img.cy), w: r(sh.cx / img.cx), h: r(sh.cy / img.cy), color: sh.color };
    if (sh.text) return { shape: 'label', text: sh.text, ...base };
    if (sh.geom === 'ellipse') return { shape: 'ellipse', ...base };
    if (['rect', 'roundRect'].includes(sh.geom)) return { shape: 'rect', ...base };
    flag('warn', `Forme « ${sh.geom} » convertie en rectangle.`); return { shape: 'rect', ...base };
  }

  // ── cartouche (en-têtes / pieds de page Word) ──
  const cartouche = await readCartouche(zip, read, flag);

  // ── corps ──
  const sectPr = path(body, 'sectPr');
  const pg = path(sectPr, 'pgSz');
  const landscape = attr(pg, 'orient') === 'landscape' || Number(attr(pg, 'w')) > Number(attr(pg, 'h'));
  let blocks = await container(body.children);

  // Planche de formulaires imprimés plusieurs par feuille : colonnes aux cellules identiques, lignes répétées.
  // On ne garde qu'un exemplaire de chaque contenu et on le signale (à reconstruire en annexe-carte).
  const sig = (b) => JSON.stringify(b);
  const before = blocks.length; let copies = 0;
  blocks = blocks.flatMap((b) => (b.type === 'columns' && b.cells.length >= 2 && b.cells.every((c) => sig(c) === sig(b.cells[0])) ? (copies += b.cells.length - 1, b.cells[0]) : [b]));
  const seen = new Set(); const distinct = blocks.filter((b) => !seen.has(sig(b)) && seen.add(sig(b)));
  if (before >= 8 && distinct.length <= blocks.length * 0.6) {
    copies += blocks.length - distinct.length; blocks = distinct;
    flag('todo', `Planche de formulaires : ${copies} bloc(s) en double fusionné(s) (cartes imprimées plusieurs par feuille). Il reste ${blocks.length} blocs (recto puis verso) : à reconstruire en annexe-carte, une carte définie une seule fois.`);
  }

  const stepAssets = blocks.filter((b) => b.type === 'steps').flatMap((b) => b.sections.flatMap((s) => s.steps.map((x) => x._asset)).filter(Boolean));
  void stepAssets;
  const strip = (x) => { if (Array.isArray(x)) x.forEach(strip); else if (x && typeof x === 'object') { delete x._asset; Object.values(x).forEach(strip); } };
  strip(blocks);
  for (const b of blocks) report.blocks[b.type] = (report.blocks[b.type] || 0) + 1;

  if (report.counts.ignoredTextBoxes) flag('todo', `${report.counts.ignoredTextBoxes} zone(s) de texte flottante(s) non convertie(s) (texte non repris).`);
  if (report.counts.ignoredShapes) flag('warn', `${report.counts.ignoredShapes} forme(s) ignorée(s).`);
  if (blocks.length === 0) flag('todo', 'Aucun contenu converti.');

  const { meta, legacy, missing } = cartouche;
  if (!meta.ref) { // pas d'en-tête (ex. annexe-formulaire) : déduit du nom de fichier, K08104-2 → K.08.104 v2 ; A134-3 → A.134 v3
    const m = /^([A-Z])(\d{2})(\d{3})-(\d+)/i.exec(source) || /^([A-Z])(\d{3})-(\d+)/i.exec(source);
    if (m) { meta.ref = m.length === 5 ? `${m[1]}.${m[2]}.${m[3]}`.toUpperCase() : `${m[1]}.${m[2]}`.toUpperCase(); meta.version = Number(m[m.length - 1]); flag('warn', `Pas d'en-tête Word : référence ${meta.ref} et version ${meta.version} déduites du nom du fichier.`); }
    else flag('todo', 'Référence du document introuvable.');
    meta.title = meta.title || source.replace(/\.[^.]+$/, ''); meta.society = meta.society || '';
    meta.created = meta.created || new Date().toISOString().slice(0, 10);
  }
  if (missing.length) flag('warn', `Cartouche : champs non retrouvés → ${missing.join(', ')}.`);
  const doc = {
    kind: 'document', layout: { orientation: landscape ? 'landscape' : 'portrait' }, status: 'brouillon',
    workflow: legacy.workflow, visas: [],
    meta: { ...meta, annexes: [], migration: { source, notes: report.flags.map((f) => f.message), legacy: legacy.visas } },
    body: blocks,
  };
  // identifiants stables de blocs (marqueur ☞, édition)
  let n = 0; const ids = (x) => { if (Array.isArray(x)) x.forEach(ids); else if (x && typeof x === 'object') { if (typeof x.type === 'string' && !x.id) x.id = `b${++n}`; Object.values(x).forEach(ids); } }; ids(doc.body);
  return { doc, report, assets: [...assets.values()] };
}

// ───────────── numérotation ─────────────

function parseNumbering(xml) {
  const out = { abs: {}, num: {} };
  if (!xml) return out;
  const root = parseXml(xml);
  for (const a of all(root, 'abstractNum')) {
    const id = a.attrs['w:abstractNumId'] ?? a.attrs.abstractNumId;
    out.abs[id] = {};
    for (const l of kids(a, 'lvl')) out.abs[id][attr(l, 'ilvl') ?? l.attrs['w:ilvl']] = { fmt: attr(kid(l, 'numFmt'), 'val'), text: attr(kid(l, 'lvlText'), 'val') || '' };
  }
  for (const n of all(root, 'num')) out.num[n.attrs['w:numId'] ?? n.attrs.numId] = attr(kid(n, 'abstractNumId'), 'val');
  return out;
}

function listInfo(numbering, numId, lvl) {
  const l = numbering.abs[numbering.num[numId]]?.[lvl];
  if (!l) return { style: 'bullet', format: '{n}.' };
  if (l.fmt === 'bullet' || l.fmt === 'none') return { style: /[✓ü]/.test(l.text) ? 'check' : 'bullet', format: '{n}.' };
  return { style: 'number', format: l.text.replace(/%\d/, '{n}') || '{n}.' };
}

// ───────────── cartouche ─────────────

async function readCartouche(zip, read, flag) {
  const names = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  const parsed = [];
  for (const n of names) {
    const x = parseXml(await read(n));
    const rows = all(x, 'tr').map((r) => kids(r, 'tc').map((tc) => kids(tc, 'p').map((p) => plainOf(toMarkup(runSegments(p)))).filter(Boolean).join('\n')));
    parsed.push({ n, rows, flat: rows.flat().join('\n') });
  }
  const head = parsed.filter((p) => /Mots/i.test(p.flat)).sort((a, b) => b.flat.length - a.flat.length)[0] || parsed.filter((p) => /header/.test(p.n)).sort((a, b) => b.flat.length - a.flat.length)[0];
  const foot = parsed.find((p) => /Cr[ée]ation/i.test(p.flat));
  const missing = [];
  const need = (label, v) => { if (v == null || v === '') missing.push(label); return v; };
  const meta = { created: null, effective: null, annule: null }; const workflow = { redacteur: '', examinateur: '', approbateur: '' }; const legacy = { workflow, visas: [] };

  if (head) {
    // En-tête lu par libellés (structures observées : 4 cellules ou 7 cellules éclatées).
    const lines = head.rows.flat().flatMap((c) => c.split('\n')).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const joined = lines.join(' ');
    meta.society = need('société', lines[0]);
    meta.ref = need('référence', (/R[ée]f\.?\s*:\s*([A-Z]+\.\d+\.\d+)/.exec(joined.replace(/(\.\d+) (\d)\b/g, '$1$2')) || [])[1]);
    meta.version = Number(need('version', (/Vers?\.?\s*:\s*(\d+)/.exec(joined) || [])[1])) || 1;
    const valueOf = (re, stop) => {
      const i = lines.findIndex((l) => re.test(l)); if (i < 0) return '';
      const inline = lines[i].replace(/^[^:]*:\s*/, '').trim();
      if (inline) return inline;
      return lines[i + 1] && !stop.test(lines[i + 1]) ? lines[i + 1] : '';
    };
    const STOP = /^(Dest|Mots|R[ée]f|Vers?\.?|Page)\b/i;
    const dest = valueOf(/^Dest/i, STOP), kw = valueOf(/^Mots/i, STOP);
    meta.dest = need('destinataires', dest) ? dest.split(/\s*\/\s*/).filter(Boolean) : [];
    meta.keywords = need('mots-clés', kw) ? kw.split(/\s*\/\s*/).filter(Boolean) : [];
    // titre = tout ce qui suit la valeur des mots-clés (il peut tenir sur plusieurs paragraphes)
    const ki = lines.findIndex((l) => /^Mots/i.test(l));
    const kwEnd = ki < 0 ? -1 : /:\s*\S/.test(lines[ki]) ? ki : ki + 1;
    const title = lines.slice(kwEnd + 1).join(' ').replace(/\s+/g, ' ').trim();
    meta.title = need('titre', title) || '';
  } else missing.push('en-tête de première page');

  if (foot) {
    // Lecture par libellés, indépendante de la grille : les pieds de page observés ont 3 structures différentes
    // (4 lignes éclatées, ou 2 lignes × 3 colonnes avec la valeur sous le libellé).
    const lines = foot.rows.flat().flatMap((c) => c.split('\n')).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const LABEL = /^(Cr[ée]ation|R[ée]dacteur|Examinateurs?|Approbateur|Service|Effective|Annule|Du)\b/i;
    const after = (re) => {
      const i = lines.findIndex((l) => re.test(l)); if (i < 0) return { i, v: '' };
      const inline = lines[i].replace(/^[^:]*:\s*/, '').trim();
      if (inline) return { i, v: inline };
      const nxt = lines[i + 1]; return { i, v: nxt && !LABEL.test(nxt) ? nxt : '' };
    };
    const dates = lines.filter((l) => normDate(l)).map(normDate);
    meta.created = normDate(lines.find((l) => /^Cr[ée]ation/i.test(l)) || '') || dates[0] || null;
    const red = /R[ée]dacteur\s+Version\s*(\d+)\s*:\s*(\S+)/i.exec(lines.join('\n'));
    workflow.redacteur = red?.[2] || ''; need('rédacteur', workflow.redacteur);
    const ex = after(/^Examinateurs?\b/i), ap = after(/^Approbateur\b/i);
    workflow.examinateur = ex.v.split(/\s/)[0]; need('examinateur', workflow.examinateur);
    workflow.approbateur = ap.v.split(/\s/)[0]; need('approbateur', workflow.approbateur);
    const si = lines.findIndex((l) => /^Service/i.test(l));
    const isOrphan = (l) => !LABEL.test(l) && !normDate(l) && !/^[\d/\-–]+$/.test(l);
    const used = new Set([ex.v, ap.v, red?.[2]]);
    meta.service = (lines[si]?.replace(/^[^:]*:\s*/, '').trim()) || lines.slice(si + 1).find((l) => isOrphan(l) && !used.has(l)) || '';
    const fns = lines.slice(0, si < 0 ? lines.length : si).filter((l) => isOrphan(l) && !used.has(l) && !/^R[ée]dacteur/i.test(l) && !/:/.test(l));
    meta.effective = dates[1] || null;
    const av = /Annule version\s*:?\s*(\d+)?/i.exec(lines.join(' ')); const avN = lines.slice(lines.findIndex((l) => /^Annule/i.test(l))).slice(0, 3).join(' ').match(/Annule version\s*:\s*(\d+)\b|^\s*(\d+)$/);
    const annNum = (/Annule version\s*:\s*(\d+)/i.exec(lines.join(' ')) || [])[1] || (/Annule version\s*:\s*$/i.test(lines.find((l) => /^Annule/i.test(l)) || '') ? lines[lines.findIndex((l) => /^Annule/i.test(l)) + 1].match(/^\d+$/)?.[0] : null);
    void av; void avN;
    meta.annule = annNum ? { version: Number(annNum), date: dates[2] || null } : null;
    need('date de création', meta.created);
    const fn = { redacteur: '', examinateur: fns[0] || '', approbateur: fns[1] || '' };
    const date = meta.effective || meta.created;
    for (const role of ['redacteur', 'examinateur', 'approbateur']) if (workflow[role]) legacy.visas.push({ role, userId: workflow[role], name: workflow[role], function: fn[role], date });
  } else missing.push('pied de page (visas)');
  void flag;
  return { meta, legacy, missing };
}
