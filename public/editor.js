// Éditeur de documents structurés. Édition générique par « chemins » JSON : chaque champ porte data-path,
// un seul gestionnaire d'événements applique les changements puis rafraîchit l'aperçu (même moteur que le PDF).
import { renderScreenHtml, esc } from '/src/render.js';
import { changedBlockIds } from '/src/diff.js';

const $ = (s) => document.querySelector(s);
const S = { list: [], cat: { docs: {}, users: {} }, doc: null, prev: null, info: null, user: null, dirty: false, tpl: false, closed: new Set(), tab: 'editor' };

// ───────────── utilitaires ─────────────
const get = (o, path) => path.reduce((a, k) => (a == null ? a : a[k]), o);
const parent = (path) => [get(S.doc, path.slice(0, -1)), path[path.length - 1]];
const P = (path) => path.join('.');
const unP = (s) => s.split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k));
const rid = () => 'b' + Math.random().toString(36).slice(2, 8);
const ro = () => !S.doc || S.doc.status !== 'brouillon';
const fr = (iso) => (iso ? iso.split('-').reverse().join('/') : '–');

async function api(path, method = 'GET', json) {
  const r = await fetch('/api' + path, { method, headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'on' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), err ? 5000 : 2200);
}
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } } };

// ───────────── registre des blocs ─────────────
const TYPES = {
  heading: ['Titre', () => ({ type: 'heading', text: 'Nouveau titre', level: 1, numbered: true })],
  text: ['Texte', () => ({ type: 'text', text: '' })],
  list: ['Liste', () => ({ type: 'list', style: 'bullet', items: ['Premier point'] })],
  callout: ['Encadré Attention / Info', () => ({ type: 'callout', kind: 'attention', text: '' })],
  keyvalue: ['Fiche clé / valeur', () => ({ type: 'keyvalue', rows: [['Clé :', 'Valeur']] })],
  table: ['Tableau', () => ({ type: 'table', headers: ['Colonne 1', 'Colonne 2'], rows: [['', '']] })],
  steps: ['Étapes illustrées (captures annotées)', () => ({ type: 'steps', headers: ['N°', 'Opérations', ''], sections: [{ title: '', steps: [{ text: '', image: { src: '', annotations: [] } }] }] })],
  columns: ['Colonnes', () => ({ type: 'columns', widths: [1, 1], cells: [[], []] })],
  box: ['Cadre titré', () => ({ type: 'box', title: 'Titre du cadre', children: [] })],
  photos: ['Rangée de photos', () => ({ type: 'photos', perRow: 2, items: [{ caption: '' }, { caption: '' }] })],
  image: ['Image seule', () => ({ type: 'image', width: '80%', caption: '' })],
  docref: ['Renvoi vers un document GED', () => ({ type: 'docref', ref: '' })],
  annexes: ['Liste des annexes', () => ({ type: 'annexes' })],
  annexpreview: ['Aperçu d’une annexe', () => ({ type: 'annexpreview', ref: 'A.134', face: 'recto', count: 1, zoom: 0.6 })],
  checklist: ['Checklist', () => ({ type: 'checklist', columns: ['OK', 'NOK', 'NA'], items: ['Point de contrôle'] })],
  fields: ['Champs à remplir', () => ({ type: 'fields', items: [{ label: 'Nom :' }] })],
  checks: ['Cases à cocher', () => ({ type: 'checks', label: 'Objet', cols: 2, options: ['option 1', 'option 2'] })],
  area: ['Zone de saisie', () => ({ type: 'area', label: 'Libellé', grow: true })],
  choice: ['Choix GO / NO GO', () => ({ type: 'choice', options: ['GO', 'NO GO'] })],
  yesno: ['Oui / Non', () => ({ type: 'yesno', label: 'Question' })],
  visatable: ['Tableau de visas', () => ({ type: 'visatable', columns: ['Équipe', 'Visa'], rows: 3 })],
  pagebreak: ['Saut de page', () => ({ type: 'pagebreak' })],
  spacer: ['Espace', () => ({ type: 'spacer', height: '6mm' })],
};
const PALETTE = [['Texte', ['heading', 'text', 'list', 'callout']], ['Structure', ['steps', 'columns', 'box', 'keyvalue', 'table']], ['Médias et liens', ['photos', 'image', 'docref', 'annexes', 'annexpreview']], ['Formulaire', ['checklist', 'fields', 'checks', 'area', 'choice', 'yesno', 'visatable']], ['Mise en page', ['pagebreak', 'spacer']]];
const typeLabel = (t) => TYPES[t]?.[0] || (t === 'repeat' ? 'Section répétable' : t);

function summary(b) {
  const clip = (s, n = 60) => String(s ?? '').replace(/\*\*|__/g, '').replace(/\n/g, ' ').slice(0, n);
  switch (b.type) {
    case 'heading': case 'callout': case 'text': return clip(b.text);
    case 'box': return clip(b.title);
    case 'list': return `${(b.items || []).length} éléments`;
    case 'columns': return `${(b.widths || []).length} colonnes`;
    case 'photos': return `${(b.items || []).length} photos`;
    case 'docref': case 'annexpreview': return b.ref;
    case 'repeat': return `${(b.instances || []).length} instances`;
    case 'steps': return `${(b.sections || []).reduce((n, x) => n + (x.steps || []).length, 0)} étapes`;
    case 'keyvalue': return `${(b.rows || []).length} lignes`;
    default: return '';
  }
}

// ───────────── champs ─────────────
const dis = (lock) => (ro() || lock ? ' disabled' : '');
let LOCK = false; // vrai pendant le rendu d'un bloc verrouillé par le modèle
const attr = (path, t, extra = '') => `data-path="${P(path)}" data-t="${t}" ${extra}${dis(LOCK)}`;

const fText = (label, path, v, extra = '') => `<label class="f">${esc(label)}<input type="text" value="${esc(v ?? '')}" ${attr(path, 'str', extra)}></label>`;
const fArea = (label, path, v, rows = 3, t = 'str', extra = '') => `<label class="f">${esc(label)}<textarea rows="${rows}" ${attr(path, t, extra)}>${esc(v ?? '')}</textarea></label>`;
const fSel = (label, path, v, opts) => `<label class="f">${esc(label)}<select ${attr(path, 'str')}>${opts.map(([val, l]) => `<option value="${esc(val)}"${String(val) === String(v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const fNum = (label, path, v) => `<label class="f">${esc(label)}<input type="number" step="any" value="${esc(v ?? '')}" ${attr(path, 'num')}></label>`;
const fChk = (label, path, v) => `<label class="chk"><input type="checkbox" ${v ? 'checked' : ''} ${attr(path, 'bool')}>${esc(label)}</label>`;
const esc1 = (s) => String(s ?? '').replace(/\n/g, '\\n');
const fLines = (label, path, arr, hint = '', keep = false) => fArea(label + (hint ? ` — ${hint}` : ''), path, (arr || []).join('\n'), Math.min(8, Math.max(2, (arr || []).length + 1)), 'lines', keep ? 'data-keep="1"' : '');
const fRows = (label, path, rows, t, hint) => fArea(`${label}${hint ? ` — ${hint}` : ''}`, path, (rows || []).map((r) => r.map(esc1).join(' | ')).join('\n'), Math.min(8, Math.max(2, (rows || []).length + 1)), t);

// ───────────── éditeur de blocs ─────────────
function blockList(path) {
  const arr = get(S.doc, path);
  const list = Array.isArray(arr) ? arr : arr ? [arr] : [];
  const add = ro() ? '' : `<div class="add"><select data-act="add" data-path="${P(path)}"><option value="">＋ Ajouter un bloc…</option>${PALETTE.map(([g, ts]) => `<optgroup label="${g}">${ts.map((t) => `<option value="${t}">${TYPES[t][0]}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
  return `${list.map((b, i) => blockEditor(b, [...path, i])).join('')}${add}`;
}

function blockEditor(b, path) {
  const lk = !!b.locked && !S.tpl;
  const prevLock = LOCK; LOCK = lk;
  const closed = S.closed.has(b.id);
  const tools = ro() || lk ? (lk ? '<span title="Imposé par le modèle">🔒</span>' : '') :
    `<button class="btn sm" data-act="up" data-path="${P(path)}" title="Monter" aria-label="Monter">↑</button><button class="btn sm" data-act="down" data-path="${P(path)}" title="Descendre" aria-label="Descendre">↓</button><button class="btn sm" data-act="dup" data-path="${P(path)}" title="Dupliquer" aria-label="Dupliquer">⧉</button><button class="btn sm" data-act="del" data-path="${P(path)}" title="Supprimer" aria-label="Supprimer">✕</button>`;
  const html = `<div class="blk${lk ? ' locked' : ''}"><div class="bh"><span class="t" data-act="toggle" data-id="${esc(b.id || '')}" style="cursor:pointer">${closed ? '▸' : '▾'} ${esc(typeLabel(b.type))}</span><span class="s">${esc(summary(b))}</span>${tools}</div>${closed ? '' : `<div class="bb">${blockBody(b, path)}</div>`}</div>`;
  LOCK = prevLock;
  return html;
}

const STYLE_OPTS = [['bullet', 'Puces'], ['number', 'Numérotée'], ['check', 'Coches ✓']];

function blockBody(b, path) {
  const p = (k) => [...path, k];
  switch (b.type) {
    case 'heading': return `${fText('Texte du titre', p('text'), b.text)}<div class="row">${fSel('Niveau', p('level'), b.level || 1, [[1, 'Niveau 1'], [2, 'Niveau 2']])}${fChk('Numérotation automatique', p('numbered'), b.numbered !== false)}</div>`;
    case 'text': return fArea('Texte — **gras**, __souligné__, [[REF]] = renvoi GED ; une ligne = un paragraphe', p('text'), b.text, 4);
    case 'list': return `<div class="grid2">${fSel('Style', p('style'), b.style || 'bullet', STYLE_OPTS)}${b.style === 'number' ? fText('Format du numéro', p('format'), b.format || '{n}.') : ''}</div>${fLines('Éléments (un par ligne)', p('items'), b.items, '« ~ » début = ligne de suite ; « ! » = modifié dans cette version')}${fChk('Retrait', p('indent'), b.indent)}`;
    case 'callout': return `<div class="grid2">${fSel('Type', p('kind'), b.kind || 'attention', [['attention', 'Attention'], ['info', 'Information']])}${fText('Libellé (optionnel)', p('label'), b.label)}</div>${fArea('Texte', p('text'), b.text, 3)}`;
    case 'keyvalue': return `${fRows('Lignes (clé | valeur)', p('rows'), b.rows, 'pairs', '« \\n » = retour à la ligne')}${fChk('Avec bordures', p('bordered'), b.bordered !== false)}`;
    case 'table': return `${fArea('En-têtes (séparés par « | »)', p('headers'), (b.headers || []).join(' | '), 1, 'csv')}${fRows('Lignes (cellules séparées par « | »)', p('rows'), b.rows, 'pairs')}`;
    case 'box': return `${fText('Titre du cadre', p('title'), b.title)}<div class="sub"><h4>Contenu</h4>${blockList(p('children'))}</div>`;
    case 'columns': return `<label class="f">Largeurs relatives (ex. 1, 1, 2 — le nombre de valeurs fixe le nombre de colonnes)<input type="text" value="${esc((b.widths || []).join(', '))}" data-ev="change" ${attr(p('widths'), 'widths')}></label>${(b.cells || []).map((_, i) => `<div class="sub"><h4>Colonne ${i + 1}</h4>${blockList([...path, 'cells', i])}</div>`).join('')}`;
    case 'photos': return `${fSel('Photos par ligne', p('perRow'), b.perRow || 2, [[1, '1'], [2, '2'], [3, '3'], [4, '4']])}${(b.items || []).map((it, i) => `<div class="row" style="align-items:flex-end">${it.src ? `<img class="thumb" src="${esc(it.src)}" alt="">` : ''}<div style="flex:1;min-width:160px">${fText(`Légende ${i + 1}`, [...path, 'items', i, 'caption'], it.caption)}</div><input type="file" accept="image/*" capture="environment" data-act="upload" data-path="${P([...path, 'items', i, 'src'])}"${dis(LOCK)} aria-label="Image ${i + 1}">${ro() || LOCK ? '' : `<button class="btn sm" data-act="delphoto" data-path="${P([...path, 'items', i])}">✕</button>`}</div>`).join('')}${ro() || LOCK ? '' : `<div><button class="btn sm" data-act="addphoto" data-path="${P(path)}">＋ Photo</button></div>`}`;
    case 'image': return `<div class="row" style="align-items:flex-end">${b.src ? `<img class="thumb" src="${esc(b.src)}" alt="">` : ''}<input type="file" accept="image/*" capture="environment" data-act="upload" data-path="${P(p('src'))}"${dis(LOCK)}></div><div class="grid2">${fText('Légende', p('caption'), b.caption)}${fText('Largeur (ex. 70% ou 80mm)', p('width'), b.width)}</div>`;
    case 'docref': return `<label class="f">Référence du document<input list="refs" type="text" value="${esc(b.ref ?? '')}" ${attr(p('ref'), 'str')}></label><div class="muted">${S.cat.docs[b.ref] ? `→ ${esc(S.cat.docs[b.ref].meta.title.replace(/\n/g, ' '))} (v${S.cat.docs[b.ref].meta.version})` : '⚠ document introuvable dans la GED'}</div>`;
    case 'annexes': return '<div class="muted">Liste automatique : se construit à partir des « Annexes liées » du cartouche.</div>';
    case 'annexpreview': return `<div class="grid2"><label class="f">Annexe<input list="refs" type="text" value="${esc(b.ref ?? '')}" ${attr(p('ref'), 'str')}></label>${fSel('Face', p('face'), b.face || 'recto', (S.cat.docs[b.ref]?.card?.faces || [{ id: 'recto' }]).map((f) => [f.id, f.id]))}${fNum('Nombre de cartes', p('count'), b.count || 1)}${fNum('Échelle', p('zoom'), b.zoom || 0.6)}</div>`;
    case 'checklist': return `${fLines('Points de contrôle (un par ligne)', p('items'), b.items)}${fArea('Colonnes de résultat (séparées par « | »)', p('columns'), (b.columns || []).join(' | '), 1, 'csv')}`;
    case 'fields': return fRows('Champs (libellé | largeur relative)', p('items'), (b.items || []).map((f) => [f.label, f.width ?? '']), 'fields');
    case 'checks': return `<div class="grid2">${fText('Libellé', p('label'), b.label)}${fNum('Colonnes', p('cols'), b.cols || 2)}</div>${fLines('Options (un par ligne ; fin par « … » = sans case ; ligne vide = espace)', p('options'), b.options, '', true)}`;
    case 'area': return `<div class="grid2">${fText('Libellé', p('label'), b.label)}${fText('Hauteur mini (ex. 30mm)', p('height'), b.height)}</div><div class="row">${fChk('Occupe l’espace restant', p('grow'), b.grow !== false)}${fChk('Libellé grisé', p('shade'), b.shade)}</div>`;
    case 'choice': return `${fLines('Options', p('options'), b.options)}${fChk('Ajouter une case « N° »', p('number'), b.number)}`;
    case 'yesno': return fText('Libellé', p('label'), b.label);
    case 'visatable': return `${fArea('Colonnes (séparées par « | »)', p('columns'), (b.columns || []).join(' | '), 1, 'csv')}${fNum('Lignes vides', p('rows'), b.rows || 3)}`;
    case 'spacer': return fText('Hauteur (ex. 6mm)', p('height'), b.height);
    case 'pagebreak': return '<div class="muted">Saut de page.</div>';
    case 'repeat': return repeatBody(b, path);
    case 'steps': return stepsBody(b, path);
    default: return `<div class="muted">Type non éditable : ${esc(b.type)}</div>`;
  }
}


// Étapes illustrées : sections → étapes (texte + capture) → annotations positionnées en % de l'image.
function stepsBody(b, path) {
  const p = (...k) => [...path, ...k];
  const edit = !ro() && !LOCK;
  const btns = (pa) => (edit ? `<button class="btn sm" data-act="up" data-path="${P(pa)}" aria-label="Monter">↑</button><button class="btn sm" data-act="down" data-path="${P(pa)}" aria-label="Descendre">↓</button><button class="btn sm" data-act="del" data-path="${P(pa)}" aria-label="Supprimer">✕</button>` : '');
  const annEd = (a, pa) => `<div class="row" style="align-items:flex-end;gap:6px">
      <label class="f" style="width:96px">Forme<select ${attr([...pa, 'shape'], 'str')}>${[['ellipse', 'Cercle'], ['rect', 'Cadre'], ['label', 'Étiquette']].map(([v, l]) => `<option value="${v}"${a.shape === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${['x', 'y', 'w', 'h'].map((k) => `<label class="f" style="width:68px">${k.toUpperCase()} %<input type="number" step="0.5" value="${esc(a[k] ?? '')}" ${attr([...pa, k], 'num')}></label>`).join('')}
      ${a.shape === 'label' ? `<label class="f" style="width:70px">Texte<input type="text" value="${esc(a.text ?? '')}" ${attr([...pa, 'text'], 'str')}></label>` : ''}
      <label class="f" style="width:96px">Couleur<input type="text" value="${esc(a.color ?? '#ff0000')}" ${attr([...pa, 'color'], 'str')}></label>
      ${edit ? `<button class="btn sm" data-act="del" data-path="${P(pa)}" aria-label="Supprimer l’annotation">✕</button>` : ''}</div>`;
  const stepEd = (st, pa) => `<div class="blk"><div class="bh"><span class="t">Étape</span><span class="s">${esc(String(st.text || '').split('\n')[0].replace(/\*\*|__/g, '').slice(0, 60))}</span>${btns(pa)}</div><div class="bb">
      ${fArea('Texte — une ligne par paragraphe ; « - » en début de ligne = tiret', [...pa, 'text'], st.text, 3)}
      <div class="row" style="align-items:flex-start">${st.image?.src ? `<img class="thumb" src="${esc(st.image.src)}" alt="">` : ''}<input type="file" accept="image/*" capture="environment" data-act="upload" data-path="${P([...pa, 'image', 'src'])}"${dis(LOCK)} aria-label="Capture d’écran"></div>
      ${(st.image?.annotations || []).map((a, j) => annEd(a, [...pa, 'image', 'annotations', j])).join('')}
      ${edit && st.image?.src ? `<div class="row"><button class="btn sm" data-act="addann" data-shape="ellipse" data-path="${P([...pa, 'image'])}">＋ Cercle</button><button class="btn sm" data-act="addann" data-shape="rect" data-path="${P([...pa, 'image'])}">＋ Cadre</button><button class="btn sm" data-act="addann" data-shape="label" data-path="${P([...pa, 'image'])}">＋ Étiquette</button></div>` : ''}
    </div></div>`;
  return `${fArea('En-têtes (N° | Opérations)', p('headers'), (b.headers || []).join(' | '), 1, 'csv')}
    ${(b.sections || []).map((sec, si) => `<details class="blk" open><summary class="bh"><span class="t">Section</span><span class="s">${esc(sec.title || '(sans titre)')} · ${(sec.steps || []).length} étapes</span>${btns(p('sections', si))}</summary><div class="bb">
      ${fText('Titre de la section', p('sections', si, 'title'), sec.title)}
      ${(sec.steps || []).map((st, i) => stepEd(st, p('sections', si, 'steps', i))).join('')}
      ${edit ? `<div><button class="btn sm" data-act="addstep" data-path="${P(p('sections', si))}">＋ Étape</button></div>` : ''}</div></details>`).join('')}
    ${edit ? `<div><button class="btn sm" data-act="addsec" data-path="${P(path)}">＋ Section</button></div>` : ''}`;
}

// Section répétable : contenus partagés / jeux / instances (surcharges).
function repeatBody(b, path) {
  const p = (...k) => [...path, ...k];
  const presetKeys = Object.keys(b.presets || {});
  const eff = (inst, name) => inst.slots?.[name] ?? b.presets?.[inst.preset]?.[name] ?? b.shared?.[name] ?? [];
  const slotNames = Object.keys(b.shared || {});
  const slotsEditors = (base, obj) => Object.keys(obj || {}).map((n) => `<details><summary>${esc(n)}</summary>${blockList([...base, n])}</details>`).join('');
  const inst = (b.instances || []).map((it, i) => {
    const mine = Object.keys(it.slots || {});
    const free = slotNames.filter((n) => !mine.includes(n));
    return `<details class="blk"><summary class="bh"><span class="t">${esc(it.title)}</span><span class="s">${it.preset ? `jeu ${esc(it.preset)} · ` : ''}${mine.length} contenu(s) propre(s)</span>${ro() ? '' : `<button class="btn sm" data-act="up" data-path="${P(p('instances', i))}">↑</button><button class="btn sm" data-act="down" data-path="${P(p('instances', i))}">↓</button><button class="btn sm" data-act="dup" data-path="${P(p('instances', i))}">⧉</button><button class="btn sm" data-act="del" data-path="${P(p('instances', i))}">✕</button>`}</summary><div class="bb">
      ${fText('Titre de l’instance', p('instances', i, 'title'), it.title)}
      ${fSel('Jeu de contenus', p('instances', i, 'preset'), it.preset || '', [['', 'Contenus partagés (par défaut)'], ...presetKeys.map((k) => [k, k])])}
      ${mine.map((n) => `<div class="sub"><h4>${esc(n)} — propre à cette instance ${ro() ? '' : `<button class="btn sm" data-act="unoverride" data-path="${P(p('instances', i, 'slots', n))}">Revenir au contenu partagé</button>`}</h4>${blockList(p('instances', i, 'slots', n))}</div>`).join('')}
      ${ro() || !free.length ? '' : `<select data-act="override" data-path="${P(p('instances', i))}" data-from="${P(path)}" class="add"><option value="">＋ Surcharger un contenu partagé…</option>${free.map((n) => `<option>${esc(n)}</option>`).join('')}</select>`}
    </div></details>`;
  }).join('');
  return `${fText('Titre des instances (modèle, {title} = titre de l’instance)', p('titleTemplate'), b.titleTemplate)}
    <div class="sub"><h4>Contenus partagés — une modification s’applique à toutes les instances qui ne les surchargent pas</h4>${slotsEditors(p('shared'), b.shared)}${presetKeys.map((k) => `<details><summary><b>Jeu « ${esc(k)} »</b></summary><div class="sub">${slotsEditors(p('presets', k), b.presets[k])}</div></details>`).join('')}</div>
    <div class="sub"><h4>Instances (${(b.instances || []).length})</h4>${inst}${ro() ? '' : `<button class="btn sm" data-act="addinst" data-path="${P(path)}">＋ Ajouter une instance</button>`}</div>
    <details><summary>Mise en page du modèle (réservée au concepteur)</summary>${fArea('Définition JSON de la grille', p('layout'), JSON.stringify(b.layout, null, 2), 10, 'json', S.tpl ? 'data-ev="change"' : 'disabled')}<div class="muted">Activez le « mode concepteur » pour modifier.</div></details>`;
}

// ───────────── cartouche, visas, panneau principal ─────────────
const STATUS = { brouillon: 'Brouillon', en_verification: 'En vérification', en_approbation: 'En approbation', en_vigueur: 'En vigueur', annule: 'Annulé' };
const ROLE = { redacteur: 'Rédacteur', examinateur: 'Examinateur', approbateur: 'Approbateur' };
const badge = (s) => `<span class="badge ${s}">${STATUS[s] || s}</span>`;

function workflowPanel() {
  const d = S.doc, vis = Object.fromEntries((d.visas || []).map((v) => [v.role, v]));
  const cur = S.info.nextStep;
  const steps = ['redacteur', 'examinateur', 'approbateur'].map((r) => {
    const v = vis[r];
    return `<div class="step ${v ? 'done' : cur?.role === r ? 'cur' : ''}"><b>${ROLE[r]}</b> : ${esc(d.workflow[r])}${v ? `<br>${esc(v.function)} · ${fr(v.date)}${v.origin ? ' · repris de l’existant' : ''}<br><code>${v.hash.slice(0, 10)}…</code>` : S.cat.users[d.workflow[r]] ? `<br><span class="muted">${esc(S.cat.users[d.workflow[r]].function)} (annuaire actuel)</span>` : ''}</div>`;
  }).join('');
  const can = cur && d.workflow[cur.role] === S.user;
  const integ = (d.visas || []).length ? (S.info.integrity ? '<span class="badge en_vigueur">Contenu conforme aux visas</span>' : '<span class="badge annule">Contenu modifié après visa</span>') : '';
  return `<div class="card"><div class="row"><b>Circuit de visa</b> ${integ}</div><div class="steps">${steps}</div>
    ${cur ? `<button class="btn primary" data-act="visa" ${can ? '' : 'disabled'}>${can ? `Viser en tant que ${esc(cur.label.toLowerCase())}` : `En attente du visa ${esc(cur.label.toLowerCase())} (${esc(d.workflow[cur.role])})`}</button>` : ''}
    ${d.status === 'en_vigueur' ? '<button class="btn" data-act="revise">Créer une nouvelle version</button>' : ''}
    ${d.status === 'annule' ? '<span class="muted">Version annulée (remplacée par une version plus récente).</span>' : ''}</div>`;
}

function cartouche() {
  const d = S.doc, m = d.meta, annex = d.kind === 'annex-card';
  const locked = `<div class="card lockedbox"><div class="row" style="justify-content:space-between"><b>🔒 Cartouche — données gérées par la GED</b>${badge(d.status)}</div><div class="grid2" style="margin-top:6px">
    <div><span class="muted">Référence</span><br><b>${esc(m.ref)}</b> — version ${m.version}</div><div><span class="muted">Société</span><br>${esc(m.society || '–')}</div>
    <div><span class="muted">Service émetteur</span><br>${esc(m.service || '–')}</div><div><span class="muted">Création / mise en vigueur</span><br>${fr(m.created)} / ${fr(m.effective)}</div>
    <div><span class="muted">Annule la version</span><br>${m.annule ? `${m.annule.version} du ${fr(m.annule.date)}` : '–'}</div><div><span class="muted">Page x / N, visas</span><br>posés automatiquement</div></div></div>`;
  const edit = `<div class="card"><b>Informations du document</b>
    ${fArea(annex ? 'Titre de la carte' : 'Titre (bandeau du cartouche)', ['meta', 'title'], m.title, annex ? 2 : 2)}
    ${annex ? '' : `<div class="grid2">${fArea('Destinataires (un par ligne)', ['meta', 'dest'], (m.dest || []).join('\n'), 4, 'lines')}${fArea('Mots-clés (un par ligne)', ['meta', 'keywords'], (m.keywords || []).join('\n'), 4, 'lines')}</div>
    ${fSel('Orientation des pages', ['layout', 'orientation'], d.layout?.orientation || 'portrait', [['portrait', 'Portrait'], ['landscape', 'Paysage']])}
    ${fArea('Annexes liées (références, une par ligne)', ['meta', 'annexes'], (m.annexes || []).map((a) => a.ref).join('\n'), 2, 'refs')}`}
    ${fArea('Modifications de cette version', ['meta', 'changeNote'], m.changeNote || '', 2)}</div>`;
  const notes = m.migration ? `<details class="card"><summary>Notes de migration (${m.migration.notes.length}) — ${esc(m.migration.source)}</summary><ul class="notes">${m.migration.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '';
  return locked + edit + workflowPanel() + notes;
}

function printPanel() {
  const pr = (S.doc.print ||= {});
  return `<div class="card"><b>Impression de la feuille</b><div class="grid2" style="margin-top:6px">${fSel('Cartes par feuille A4', ['print', 'perSheet'], pr.perSheet || 4, [[1, '1'], [2, '2'], [4, '4']])}<div>${fChk('Traits de coupe', ['print', 'cutMarks'], pr.cutMarks !== false)}${fChk('Verso en miroir (recto-verso)', ['print', 'mirrorVerso'], pr.mirrorVerso !== false)}${fChk('QR vers la version en vigueur', ['print', 'qr'], pr.qr !== false)}</div></div></div>`;
}

function content() {
  const d = S.doc;
  if (d.kind === 'annex-card') {
    d.card.faces.forEach((f) => { f.header ||= {}; });
    return `${printPanel()}${d.card.faces.map((f, i) => `<h3>Face « ${esc(f.id)} » (${i + 1} / ${d.card.faces.length})</h3><div class="card">${fText('Titre de la face', ['card', 'faces', i, 'header', 'title'], f.header?.title ?? d.meta.title)}</div>${blockList(['card', 'faces', i, 'blocks'])}`).join('')}`;
  }
  return `<h3>Contenu</h3>${blockList(['body'])}`;
}

function banner() {
  const d = S.doc;
  if (d.status === 'brouillon') return '';
  return `<div class="banner ${d.status === 'en_vigueur' ? 'ok' : ''}">${d.status === 'en_vigueur' ? 'Version en vigueur : lecture seule.' : `Version « ${STATUS[d.status].toLowerCase()} » : lecture seule.`} Toute modification passe par une nouvelle version, pour garder la trace de ce qui a été visé.</div>`;
}

function renderEditor() {
  const ed = $('#editor');
  const keepY = ed.scrollTop;
  const d = S.doc;
  const vers = S.info.versions;
  $('#docinfo').innerHTML = `<b>${esc(d.meta.ref)}</b> — v${d.meta.version} ${badge(d.status)}`;
  ed.innerHTML = `<div class="row" style="margin-bottom:8px">
      <label class="f" style="min-width:110px">Version<select data-act="version">${vers.map((v) => `<option value="${v}"${v === d.meta.version ? ' selected' : ''}>v${v}</option>`).join('')}</select></label>
      <label class="chk" style="margin-top:16px"><input type="checkbox" data-act="tpl" ${S.tpl ? 'checked' : ''}>Mode concepteur de modèle</label></div>
    ${banner()}${cartouche()}${content()}
    <datalist id="refs">${Object.keys(S.cat.docs).map((r) => `<option value="${esc(r)}">`).join('')}</datalist>`;
  ed.scrollTop = keepY;
}

// ───────────── aperçu, enregistrement ─────────────
// Ajuste la feuille à la largeur du panneau (sans jamais agrandir au-delà de 100 %).
function fitPreview() {
  const frame = $('#frame'), d = frame.contentDocument;
  const sheet = d?.querySelector('.paper, .sheet'); if (!sheet) return;
  d.body.style.zoom = 1;
  d.body.style.zoom = Math.min(1, (frame.clientWidth - 24) / sheet.offsetWidth);
}
window.addEventListener('resize', fitPreview);

let pvT;
function refreshPreview() {
  clearTimeout(pvT);
  pvT = setTimeout(() => {
    const d = S.doc; if (!d) return;
    const frame = $('#frame');
    const y = frame.contentWindow?.scrollY || 0;
    const ctx = { docs: { ...S.cat.docs, [d.meta.ref]: d }, users: S.cat.users, gedUrl: (r) => `${location.origin}/?doc=${encodeURIComponent(r)}`, changed: changedBlockIds(S.prev, d) };
    frame.onload = () => { fitPreview(); frame.contentWindow.scrollTo(0, y); };
    frame.srcdoc = renderScreenHtml(d, ctx);
  }, 120);
}

let saveT;
function markDirty() {
  S.dirty = true; $('#savestate').textContent = 'Modifications non enregistrées…';
  clearTimeout(saveT); saveT = setTimeout(save, 2000);
  refreshPreview();
}
async function save() {
  clearTimeout(saveT);
  if (!S.dirty || ro()) return;
  try {
    await api(`/documents/${encodeURIComponent(S.doc.meta.ref)}`, 'PUT', S.doc);
    S.dirty = false; S.cat.docs[S.doc.meta.ref] = S.doc;
    $('#savestate').textContent = `Enregistré à ${new Date().toTimeString().slice(0, 5)}`;
  } catch (e) { $('#savestate').textContent = 'Échec de l’enregistrement'; toast(e.message, true); }
}

async function openDoc(ref, v) {
  await save();
  const res = await api(`/documents/${encodeURIComponent(ref)}${v ? `?v=${v}` : ''}`);
  S.doc = res.doc; S.info = res; S.dirty = false;
  const pv = Math.max(0, ...res.versions.filter((x) => x < res.doc.meta.version)); // version précédente existante
  S.prev = pv ? (await api(`/documents/${encodeURIComponent(ref)}?v=${pv}`)).doc : null;
  S.cat = await api('/catalog');
  S.user = store.get('ged-user') && S.cat.users[store.get('ged-user')] ? store.get('ged-user') : S.doc.workflow.redacteur;
  fillUsers();
  $('#savestate').textContent = ro() ? 'Lecture seule' : '';
  renderList(); renderEditor(); refreshPreview();
  history.replaceState(null, '', `?doc=${encodeURIComponent(ref)}`);
}

async function reload() { await openDoc(S.doc.meta.ref, S.doc.meta.version); }

function renderList() {
  $('#list').innerHTML = S.list.map((d) => `<button class="doc${S.doc?.meta.ref === d.ref ? ' on' : ''}" data-act="open" data-ref="${esc(d.ref)}"><b>${esc(d.ref)}</b> ${badge(d.status)}<small>${esc(d.title)}</small><small>${d.kind === 'annex-card' ? 'Annexe' : 'Document'} · v${d.version}</small></button>`).join('');
}
function fillUsers() {
  const sel = $('#user');
  sel.innerHTML = Object.entries(S.cat.users).map(([id, u]) => `<option value="${id}"${id === S.user ? ' selected' : ''}>${esc(id)} — ${esc(u.function)}</option>`).join('');
}

// ───────────── événements ─────────────
function applyValue(el) {
  const path = unP(el.dataset.path), t = el.dataset.t;
  const [obj, key] = parent(path);
  if (obj == null) return false;
  const v = el.value;
  const clean = (s) => s.replace(/\\n/g, '\n');
  const lines = (s) => s.split('\n');
  switch (t) {
    case 'str': if (v === '' && key === 'preset') { delete obj[key]; break; } obj[key] = el.tagName === 'SELECT' && /^\d+$/.test(v) && ['level', 'perRow', 'perSheet'].includes(key) ? Number(v) : v; break;
    case 'num': obj[key] = v === '' ? undefined : Number(v); break;
    case 'bool': obj[key] = el.checked; break;
    case 'lines': obj[key] = el.dataset.keep ? lines(v) : lines(v).filter((s) => s.trim() !== ''); break;
    case 'refs': obj[key] = lines(v).map((s) => s.trim()).filter(Boolean).map((ref) => ({ ref })); break;
    case 'csv': obj[key] = v.split('|').map((s) => s.trim()).filter(Boolean); break;
    case 'pairs': obj[key] = lines(v).filter((s) => s.trim() !== '').map((l) => l.split(' | ').map((c) => clean(c.trim()))); break;
    case 'fields': obj[key] = lines(v).filter((s) => s.trim() !== '').map((l) => { const [label, w] = l.split(' | '); return { label: label.trim(), ...(w && !isNaN(w) ? { width: Number(w) } : {}) }; }); break;
    case 'widths': {
      const w = v.split(/[,\s]+/).map(Number).filter((n) => n > 0);
      if (!w.length) return false;
      obj[key] = w; const par = get(S.doc, path.slice(0, -1));
      par.cells = par.cells || []; while (par.cells.length < w.length) par.cells.push([]); par.cells.length = Math.max(w.length, 1);
      break;
    }
    case 'json': try { obj[key] = JSON.parse(v); el.style.outline = ''; } catch { el.style.outline = '2px solid #b42318'; return false; } break;
    default: return false;
  }
  return true;
}

$('#editor').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset?.path || el.type === 'file' || el.dataset.ev === 'change') return;
  if (applyValue(el)) markDirty();
});
$('#editor').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'upload' && el.files?.[0]) {
    const f = el.files[0];
    try {
      const r = await fetch('/api/assets', { method: 'POST', headers: { 'content-type': f.type }, body: f });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      const up = unP(el.dataset.path); let o = S.doc; // crée les objets intermédiaires manquants (ex. step.image)
      for (let n = 0; n < up.length - 1; n++) { const k = up[n]; if (o[k] == null) o[k] = typeof up[n + 1] === 'number' ? [] : {}; o = o[k]; }
      o[up[up.length - 1]] = j.src; if (up[up.length - 2] === 'image') o.annotations ??= [];
      markDirty(); renderEditor();
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (el.dataset.act === 'version') return openDoc(S.doc.meta.ref, el.value);
  if (el.dataset.act === 'tpl') { S.tpl = el.checked; return renderEditor(); }
  if (el.dataset.act === 'add' && el.value) {
    const path = unP(el.dataset.path); let arr = get(S.doc, path);
    const [pobj, pkey] = parent(path);
    if (!Array.isArray(arr)) { arr = arr ? [arr] : []; pobj[pkey] = arr; }
    arr.push({ id: rid(), ...TYPES[el.value][1]() }); markDirty(); return renderEditor();
  }
  if (el.dataset.act === 'override' && el.value) {
    const inst = get(S.doc, unP(el.dataset.path)), rep = get(S.doc, unP(el.dataset.from)), n = el.value;
    inst.slots = inst.slots || {};
    inst.slots[n] = structuredClone(inst.slots[n] ?? rep.presets?.[inst.preset]?.[n] ?? rep.shared?.[n] ?? []);
    markDirty(); return renderEditor();
  }
  if (el.dataset.path && el.dataset.ev === 'change') { if (applyValue(el)) { markDirty(); renderEditor(); } else toast('Valeur invalide', true); return; }
  if (el.dataset.path && el.tagName === 'SELECT' && /preset|perSheet|orientation|face|kind|style/.test(el.dataset.path)) renderEditor();
});

$('#editor').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox') return;
  const act = el.dataset.act;
  try {
    if (act === 'toggle') { const id = el.dataset.id; if (id) { S.closed.has(id) ? S.closed.delete(id) : S.closed.add(id); renderEditor(); } return; }
    if (act === 'visa') { await save(); await api(`/documents/${encodeURIComponent(S.doc.meta.ref)}/visa?v=${S.doc.meta.version}`, 'POST', { user: S.user }); toast('Visa enregistré'); S.list = await api('/documents'); return reload(); }
    if (act === 'revise') { await api(`/documents/${encodeURIComponent(S.doc.meta.ref)}/revise`, 'POST'); toast('Nouvelle version créée'); S.list = await api('/documents'); return openDoc(S.doc.meta.ref); }
    const path = el.dataset.path ? unP(el.dataset.path) : null; if (!path || ro()) return;
    const [arr, i] = parent(path);
    if (act === 'up' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    else if (act === 'down' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    else if (act === 'dup') { const c = structuredClone(arr[i]); const fresh = (x) => { if (Array.isArray(x)) x.forEach(fresh); else if (x && typeof x === 'object') { if (x.id) x.id = rid(); Object.values(x).forEach(fresh); } }; fresh(c); if (c.title) c.title += ' (copie)'; arr.splice(i + 1, 0, c); }
    else if (act === 'del') { if (!confirm('Supprimer cet élément ?')) return; arr.splice(i, 1); }
    else if (act === 'delphoto') arr.splice(i, 1);
    else if (act === 'addphoto') get(S.doc, path).items.push({ caption: '' });
    else if (act === 'addinst') { const r = get(S.doc, path), last = r.instances[r.instances.length - 1]; r.instances.push({ title: 'Nouvelle instance', ...(last?.preset ? { preset: last.preset } : {}), slots: structuredClone(last?.slots || {}) }); }
    else if (act === 'unoverride') delete arr[i];
    else if (act === 'addstep') get(S.doc, path).steps.push({ text: '', image: { src: '', annotations: [] } });
    else if (act === 'addsec') get(S.doc, path).sections.push({ title: 'Nouvelle section', steps: [] });
    else if (act === 'addann') { const im = get(S.doc, path); (im.annotations ||= []).push({ shape: el.dataset.shape, x: 30, y: 30, w: 25, h: 18, color: '#ff0000', ...(el.dataset.shape === 'label' ? { text: '1' } : {}) }); }
    else return;
    markDirty(); renderEditor();
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act="open"]'); if (b) { openDoc(b.dataset.ref).catch((err) => toast(err.message, true)); }
});
$('#user').addEventListener('change', (e) => { S.user = e.target.value; store.set('ged-user', S.user); renderEditor(); });
$('#btn-pdf').addEventListener('click', async () => {
  try {
    $('#btn-pdf').disabled = true; toast('Génération du PDF…');
    const blob = await api('/render/pdf', 'POST', S.doc);
    $('#pdfframe').src = URL.createObjectURL(blob); $('#modal').hidden = false;
  } catch (err) { toast(err.message, true); } finally { $('#btn-pdf').disabled = false; }
});
$('#mclose').addEventListener('click', () => { $('#modal').hidden = true; });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save().then(() => toast('Enregistré')); } if (e.key === 'Escape') $('#modal').hidden = true; });
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { document.body.dataset.tab = b.dataset.tab; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); }));
document.body.dataset.tab = 'editor';
window.addEventListener('beforeunload', (e) => { if (S.dirty && !ro()) { e.preventDefault(); } });

// ───────────── démarrage ─────────────
(async () => {
  try {
    S.list = await api('/documents');
    const want = new URLSearchParams(location.search).get('doc');
    await openDoc(S.list.find((d) => d.ref === want)?.ref || S.list[0].ref);
  } catch (e) { toast(e.message, true); }
})();
