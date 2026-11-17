// Moteur de rendu partagé : même code dans le navigateur (aperçu) et sur le serveur (PDF).
// Entrée : un document JSON + un contexte. Sortie : du HTML. Aucune dépendance.
//
// ctx = {
//   docs:   { [ref]: document }   documents de la GED (pour liens, annexes, aperçus)
//   users:  { [id]: {name, function} }  annuaire (utilisé seulement pour les visas non signés)
//   gedUrl: (ref) => string        URL de la version en vigueur dans la GED
//   qr:     (url) => string|null   SVG d'un QR code (serveur uniquement)
//   changed: Set<blockId>          blocs modifiés par rapport à la version précédente
// }

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// mini-balisage : **gras**  __souligné__
export const inline = (s, ctx) =>
  esc(s)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    // [[K.16.001]] : renvoi vers un document de la GED, titre et version à jour
    .replace(/\[\[([A-Za-z0-9._-]+)\]\]/g, (_, ref) => docrefHtml(ref, ctx));

const multi = (s, ctx) => inline(s, ctx).replace(/\n/g, '<br>');

function docrefHtml(ref, ctx) {
  const d = ctx?.docs?.[ref];
  if (!d) return `<span class="docref missing" title="Document introuvable dans la GED">${esc(ref)}</span>`;
  return `<span class="docref">${esc(ref)} <i>– ${esc(d.meta.title.replace(/\n/g, ' '))} (v${d.meta.version})</i></span>`;
}
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export const frDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || '';
};

// ───────────────────────── Blocs ─────────────────────────

const imgOrPlaceholder = (src, alt = '') =>
  src
    ? `<img src="${esc(src)}" alt="${esc(alt)}">`
    : `<div class="ph">Photo à insérer</div>`;

const BLOCKS = {
  heading(b, ctx, st) {
    const lvl = b.level === 2 ? 2 : 1;
    let num = '';
    if (b.numbered !== false) {
      if (lvl === 1) { st.h1++; st.h2 = 0; num = `${st.h1}. `; }
      else { st.h2++; num = `${st.h1}.${st.h2} `; }
    }
    return `<h${lvl + 1} class="h h${lvl}">${num}${inline(b.text)}</h${lvl + 1}>`;
  },

  text: (b, ctx) => asArray(b.text?.split?.('\n') ?? b.text).map((p) => `<p>${inline(p, ctx)}</p>`).join(''),

  // Éléments : "~ texte" = ligne de continuation (sans puce ni numéro) ;
  //            "! texte" = modifié dans cette version (affiche ☞ en marge).
  list(b, ctx) {
    const style = b.style || 'bullet';
    const fmt = b.format || '{n}.';
    let n = 0;
    return `<div class="list ${style}${b.indent ? ' indent' : ''}${b.nested ? ' nested' : ''}">${asArray(b.items)
      .map((raw) => {
        let t = String(raw), cont = false, chg = false;
        if (t.startsWith('~ ')) { cont = true; t = t.slice(2); }
        if (t.startsWith('! ')) { chg = true; t = t.slice(2); }
        let mk = '';
        if (!cont) {
          n++;
          mk = style === 'number' ? fmt.replace('{n}', n) : style === 'check' ? '✓' : '•';
        }
        return `<div class="li${cont ? ' cont' : ''}${chg ? ' chg' : ''}"><span class="mk">${mk}</span><span class="tx">${inline(t, ctx)}</span></div>`;
      })
      .join('')}</div>`;
  },

  callout: (b, ctx) =>
    `<div class="callout ${esc(b.kind || 'attention')}"><b class="lbl">${esc(
      b.label || (b.kind === 'info' ? 'Information' : 'Attention')
    )} :</b> ${multi(b.text, ctx)}</div>`,

  keyvalue: (b) =>
    `<table class="kv${b.bordered === false ? '' : ' bordered'}">${asArray(b.rows)
      .map(([k, v]) => `<tr><th>${inline(k)}</th><td>${multi(v)}</td></tr>`)
      .join('')}</table>`,

  box: (b, ctx, st) =>
    `<section class="box"><header>${inline(b.title)}</header><div class="bd">${renderBlocks(b.children, ctx, st)}</div></section>`,

  columns: (b, ctx, st) =>
    `<div class="columns" style="grid-template-columns:${asArray(b.widths).map((w) => `${w}fr`).join(' ')}">${asArray(b.cells)
      .map((cell) => `<div class="col">${renderBlocks(cell, ctx, st)}</div>`)
      .join('')}</div>`,

  photos: (b) =>
    `<div class="photos" style="grid-template-columns:repeat(${b.perRow || 3},1fr)">${asArray(b.items)
      .map((p) => `<figure>${imgOrPlaceholder(p.src, p.caption)}${p.caption ? `<figcaption>${inline(p.caption)}</figcaption>` : ''}</figure>`)
      .join('')}</div>`,

  image: (b) =>
    `<figure class="image" style="width:${esc(b.width || '100%')}">${imgOrPlaceholder(b.src, b.caption)}${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}</figure>`,

  table: (b) =>
    `<table class="grid">${asArray(b.headers).length ? `<thead><tr>${asArray(b.headers).map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>` : ''}<tbody>${asArray(b.rows)
      .map((r) => `<tr>${r.map((c) => `<td>${multi(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`,

  // Lien vers un document de la GED : titre et version toujours à jour.
  docref: (b, ctx) => docrefHtml(b.ref, ctx),

  // Liste automatique des annexes liées au document (meta.annexes).
  annexes(b, ctx) {
    const links = asArray(ctx.doc?.meta?.annexes);
    if (!links.length) return '<p class="muted">Aucune annexe.</p>';
    return `<table class="grid annexes"><thead><tr><th>N°</th><th>Réf.</th><th>Titre</th><th>Version</th><th>Formats</th></tr></thead><tbody>${links
      .map((l, i) => {
        const d = ctx.docs?.[l.ref];
        const fm = (d?.print?.formats || d?.attachment?.formats || ['pdf']).map((f) => f.toUpperCase()).join(' · ');
        return `<tr><td>${i + 1}</td><td>${esc(l.ref)}</td><td>${d ? esc(d.meta.title.replace(/\n/g, ' ')) : '<i class="missing">introuvable</i>'}</td><td>${d ? d.meta.version : '–'}</td><td>${fm}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  },

  // Aperçu d'une annexe, rendu depuis la version en vigueur (jamais une image collée).
  annexpreview(b, ctx) {
    const d = ctx.docs?.[b.ref];
    if (!d?.card) return `<div class="ph">Annexe ${esc(b.ref)} introuvable</div>`;
    const face = d.card.faces.find((f) => f.id === (b.face || 'recto')) || d.card.faces[0];
    const one = `<div class="annexprev-card" style="zoom:${b.zoom || 0.62}">${renderCard(d, face, d.card.faces.indexOf(face), ctx, { fixed: true })}</div>`;
    return `<div class="annexprev">${one.repeat(b.count || 1)}</div><div class="cap">Annexe ${esc(b.ref)} (v${d.meta.version})</div>`;
  },


  // Procédure en étapes numérotées, chacune avec une capture d'écran annotée (cercles, flèches, étiquettes).
  // La numérotation est continue sur toute la table, sections comprises. Les annotations sont des données
  // (position en % de l'image) : modifiables, non « incrustées » dans l'image.
  steps(b) {
    let n = 0;
    const hd = asArray(b.headers);
    const line = (l) => (l.startsWith('- ') ? `<div class="dash">– ${inline(l.slice(2))}</div>` : `<div>${inline(l)}</div>`);
    const ann = (a) => {
      const pos = `left:${a.x}%;top:${a.y}%;`;
      const col = esc(a.color || '#ff0000');
      return a.shape === 'label'
        ? `<b class="an label" style="${pos}color:${col}">${esc(a.text)}</b>`
        : `<i class="an ${a.shape === 'rect' ? 'rect' : 'ellipse'}" style="${pos}width:${a.w}%;height:${a.h}%;border-color:${col}"></i>`;
    };
    const img = (im) => (im?.src ? `<div class="annimg"><img src="${esc(im.src)}" alt="">${asArray(im.annotations).map(ann).join('')}</div>` : '');
    return `<table class="steps"><thead><tr><th class="c">${esc(hd[0] || 'N°')}</th><th colspan="2">${esc(hd[1] || 'Opérations')}</th></tr></thead><tbody>${asArray(b.sections)
      .map((sec) => `${sec.title ? `<tr class="sec"><td colspan="3">${inline(sec.title)}</td></tr>` : ''}${asArray(sec.steps)
        .map((st) => `<tr><td class="c">${++n}</td><td class="stx">${String(st.text || '').split('\n').filter(Boolean).map(line).join('')}</td><td class="sim">${img(st.image)}</td></tr>`)
        .join('')}`)
      .join('')}</tbody></table>`;
  },

  // ── éléments de formulaire (annexes et checklists) ──
  fields: (b) =>
    `<div class="fields">${asArray(b.items).map((f) => `<div class="fld" style="flex:${f.width || 1}"><b>${inline(f.label)}</b></div>`).join('')}</div>`,

  checks: (b) =>
    `<div class="checks"><span class="cl">${inline(b.label || '')}</span><div class="opts" style="grid-template-columns:repeat(${b.cols || 2},1fr)">${asArray(b.options)
      .map((o) => (o === '' ? '<span></span>' : /…$/.test(o) ? `<span class="o">${inline(o)}</span>` : `<span class="o">${inline(o)}<i class="cb"></i></span>`))
      .join('')}</div></div>`,

  area: (b) => `<div class="area${b.grow === false ? '' : ' grow'}${b.shade ? ' shade' : ''}"${b.height ? ` style="min-height:${esc(b.height)}"` : ''}><b>${inline(b.label || '')}</b></div>`,

  choice: (b) =>
    `<div class="choice">${asArray(b.options).map((o) => `<span>${inline(o)}</span>`).join('')}</div>${b.number ? `<div class="choice num"><span>N°</span></div>` : ''}`,

  yesno: (b) => `<div class="yesno${b.centered ? ' center' : ''}${b.right ? ' right' : ''}"><b>${inline(b.label || '')}</b> <span class="o">oui<i class="cb"></i></span> <span class="o">non<i class="cb"></i></span></div>`,

  visatable: (b) =>
    `<table class="grid visa"><thead><tr>${asArray(b.columns).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: b.rows || 3 }, () => `<tr>${asArray(b.columns).map(() => '<td></td>').join('')}</tr>`).join('')}</tbody></table>`,

  checklist(b) {
    const cols = asArray(b.columns || ['OK', 'NOK', 'NA']);
    return `<table class="grid checklist"><thead><tr><th>N°</th><th>Point de contrôle</th>${cols.map((c) => `<th class="c">${esc(c)}</th>`).join('')}<th>Commentaire</th></tr></thead><tbody>${asArray(b.items)
      .map((it, i) => `<tr><td class="c">${i + 1}</td><td>${inline(it)}</td>${cols.map(() => '<td class="c"><i class="cb"></i></td>').join('')}<td></td></tr>`)
      .join('')}</tbody></table>`;
  },

  pagebreak: () => '<div class="pb"></div>',
  spacer: (b) => `<div style="height:${esc(b.height || '4mm')}"></div>`,

  // Section répétable : même mise en page, contenus par instance.
  // Résolution d'un emplacement : instance.slots > presets[instance.preset] > shared.
  repeat(b, ctx, st) {
    return asArray(b.instances)
      .map((inst, i) => {
        const slot = (name) => inst.slots?.[name] ?? b.presets?.[inst.preset]?.[name] ?? b.shared?.[name] ?? [];
        const title = (b.titleTemplate || '{title}').replace('{title}', inst.title);
        return `<section class="rep${i > 0 ? ' newpage' : ''}"><h2 class="reptitle">${inline(title)}</h2>${renderBlocks(b.layout, { ...ctx, slot }, st)}</section>`;
      })
      .join('');
  },

  slot: (b, ctx, st) => renderBlocks(asArray(ctx.slot?.(b.slot)), ctx, st),
};

export function renderBlocks(blocks, ctx, st = { h1: 0, h2: 0 }) {
  return asArray(blocks)
    .map((b) => {
      const fn = BLOCKS[b.type];
      const html = fn ? fn(b, ctx, st) : `<div class="missing">Bloc inconnu : ${esc(b.type)}</div>`;
      return b.id && ctx.changed?.has(b.id) ? `<div class="blk changed">${html}</div>` : html;
    })
    .join('');
}

// ───────────────────────── Annexes « carte » ─────────────────────────

function renderCard(doc, face, idx, ctx, { fixed } = {}) {
  const m = doc.meta;
  const n = doc.card.faces.length;
  const h = face.header || {};
  const left = h.left === 'logo' || h.left == null
    ? `<img class="logo" src="${esc(m.logo || '')}" alt="${esc(m.society || '')}">`
    : renderBlocks(h.left, ctx);
  const title = (h.title ?? m.title).split('\n').map(esc).join('<br>');
  return `<div class="card${fixed ? ' fixed' : ''}"><div class="cardhead"><div class="chl">${left}</div><div class="chr"><div class="cref">${esc(m.ref)}&nbsp;&nbsp;(${m.version})&nbsp;&nbsp;${idx + 1} / ${n}</div><div class="ctitle" style="color:${esc(h.titleColor || 'var(--brand)')}">${title}</div></div></div><div class="cardbody">${renderBlocks(face.blocks, { ...ctx, doc })}</div></div>`;
}

function renderSheets(doc, ctx) {
  const p = doc.print || {};
  const per = [1, 2, 4].includes(p.perSheet) ? p.perSheet : 4;
  const url = ctx.gedUrl ? ctx.gedUrl(doc.meta.ref) : '';
  const qr = p.qr !== false ? ctx.qr?.(url) || '<div class="qrph">QR</div>' : '';
  return doc.card.faces
    .map((face, i) => {
      const cards = Array.from({ length: per }, () => renderCard(doc, face, i, ctx)).join('');
      return `<section class="sheet ${esc(face.id)}"><div class="sgrid g${per}${p.cutMarks !== false ? ' cut' : ''}${p.mirrorVerso !== false && i > 0 ? ' mirror' : ''}">${cards}</div><footer class="sfoot"><div class="qr">${qr}</div><div>Copie imprimée <b>non contrôlée</b> — ${esc(doc.meta.ref)} version ${doc.meta.version}.<br>Version en vigueur : ${esc(url)}</div></footer></section>`;
    })
    .join('');
}

// ───────────────────────── Cartouche ─────────────────────────

export function visaColumns(doc, ctx = {}) {
  const w = doc.workflow || {};
  const by = Object.fromEntries(asArray(doc.visas).map((v) => [v.role, v]));
  const who = (role) => by[role] || { name: w[role] || '', function: ctx.users?.[w[role]]?.function || '' };
  const m = doc.meta;
  const ex = who('examinateur'), ap = who('approbateur'), re = who('redacteur');
  return [
    [`Création le ${frDate(m.created)}`, `Rédacteur Version ${m.version} : ${re.name}`, 'Service émetteur :', m.service || ''],
    [`Examinateur : ${ex.name}`, ex.function, 'Effective le :', frDate(m.effective) || '–'],
    [`Approbateur : ${ap.name}`, ap.function, `Annule version : ${m.annule ? m.annule.version : '//'}`, `Du : ${m.annule ? frDate(m.annule.date) : '-'}`],
  ];
}

const visaTable = (doc, ctx) =>
  `<table class="visablock"><tr>${visaColumns(doc, ctx).map((c) => `<td>${c.map((l, i) => (i % 2 ? esc(l) : `<i>${esc(l)}</i>`)).join('<br>')}</td>`).join('')}</tr></table>`;

function identification(doc) {
  const m = doc.meta;
  return `<table class="ident"><tr><td class="dest"><i>Dest : ${esc(asArray(m.dest).join(' / '))}</i></td><td class="kw"><i>Mots-clés : ${esc(asArray(m.keywords).join(' / '))}</i></td></tr><tr><td colspan="2" class="ttl">${esc(m.title)}</td></tr></table>`;
}

// ───────────────────────── Feuille de style ─────────────────────────

const cssStr = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ')}"`;

const BASE_CSS = `
:root{--brand:#7ab800;--blue:#2f5496;--shade:#d9e2f3;--line:.3mm solid #000}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font:10pt/1.3 Arial,"Liberation Sans",Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
p{margin:0 0 2mm}
b{font-weight:700} i{font-style:italic}
.h{margin:4mm 0 2mm;font-size:11pt} .h1{text-decoration:underline} .h2{font-style:italic;font-size:10.5pt}
.list .li{display:flex;gap:2mm;margin:.4mm 0;position:relative} .list .mk{flex:0 0 5mm;text-align:right} .list .cont .mk{visibility:hidden}
.list.check .mk{text-align:left;flex-basis:5mm}
.li.chg::before,.blk.changed::before{content:"☞";font-family:"DejaVu Sans","Segoe UI Symbol",sans-serif;position:absolute;left:-6.5mm;top:0}
.content.marks{padding-left:7mm}
.blk.changed{position:relative}
.callout{margin:2mm 0;padding:1.5mm 2.5mm;border-left:1.2mm solid #c00;background:#fdf0f0} .callout .lbl{color:#c00;text-decoration:underline}
.callout.info{border-color:var(--blue);background:#eef3fb} .callout.info .lbl{color:var(--blue)}
table{border-collapse:collapse;width:100%}
table.bordered td,table.bordered th{border:var(--line);padding:1mm 2mm;vertical-align:top;text-align:left}
table.kv th{font-style:italic;font-weight:700;width:38%}
table.grid th,table.grid td{border:var(--line);padding:1mm 2mm;text-align:left;vertical-align:top} table.grid th{background:var(--shade)} .c{text-align:center!important;width:10mm}
.box{border:var(--line);display:flex;flex-direction:column;height:100%} .box>header{background:var(--shade);border-bottom:var(--line);font-weight:700;text-decoration:underline;padding:.6mm 2mm;font-size:9pt} .box>.bd{padding:1mm 2mm;flex:1;font-size:8.5pt}
.columns{display:grid;gap:0;break-inside:avoid} .columns>.col{min-width:0;display:flex;flex-direction:column;gap:2mm}
.columns>.col>.box{margin:0 -.3mm -.3mm 0;flex:1}
.photos{display:grid;gap:3mm;margin:2mm 0;justify-items:center} .photos figure,figure.image{margin:0;text-align:center;width:100%}
.photos img,figure.image img{display:block;width:100%;height:auto;border:.6mm solid #000}.photos img{max-height:52mm;object-fit:cover}
figcaption{font-weight:700;font-style:italic;text-decoration:underline;margin-top:1mm;font-size:9pt}
.ph{border:.3mm dashed #888;color:#888;background:#f3f3f3;min-height:30mm;display:flex;align-items:center;justify-content:center;font-size:9pt}
.cap{font-size:8pt;color:#555;font-style:italic}
.docref{white-space:nowrap} .docref i{font-style:normal;color:#444} .missing{color:#b00;text-decoration:underline dotted}
.muted{color:#666} .pb{break-after:page}
.reptitle{color:var(--blue);text-align:center;font-size:14pt;margin:3mm 0 2mm} .rep.newpage{break-before:page}
.ident{border:var(--line);border-top:0} .ident td{border:var(--line);padding:1.2mm 2mm;font-size:9.5pt} .ident .ttl{text-align:center;font-weight:700;font-style:italic;font-size:12.5pt;padding:1.6mm}
.ident .kw{width:30%}
.visablock td{border:var(--line);padding:1mm 2mm;font-size:8pt;vertical-align:top;width:33.3%}
/* formulaires */
.fields{display:flex;gap:4mm;margin:1mm 0} .fld{font-size:8pt}
.checks{display:flex;gap:3mm;font-size:8pt;margin:1mm 0} .checks .cl{flex:0 0 auto} .checks .opts{display:grid;flex:1;gap:.4mm 6mm}
.o{display:flex;justify-content:space-between;align-items:center;gap:2mm;white-space:nowrap}
.cb{display:inline-block;width:3mm;height:3mm;border:.3mm solid #000;vertical-align:middle;flex:0 0 3mm}
.area{border-top:var(--line);padding:1mm 2mm;font-size:8pt;min-height:12mm} .area.grow{flex:1}
.choice{display:inline-flex;border:var(--line);font-size:7.5pt;font-weight:700} .choice span{padding:.8mm 4mm;min-width:11mm;text-align:center} .choice span+span{border-left:var(--line)} .choice.num{display:flex;margin-top:-.3mm;width:max-content}
.yesno{display:flex;gap:3mm;align-items:center;font-size:8pt}
table.grid.visa th{background:none} table.visa th,table.visa td{font-size:7.5pt;height:5mm;text-align:center!important}
table.checklist td{height:7mm}
/* cartes */
.card{display:flex;flex-direction:column;border:.35mm solid #000;height:100%;direction:ltr;background:#fff;overflow:hidden}
.card.fixed{width:94mm;height:132mm}
.cardhead{display:flex;justify-content:space-between;align-items:flex-start;padding:2mm 2mm 1mm;min-height:17mm}
.cardhead .logo{height:11mm;width:auto;display:block} .chr{text-align:center;font-weight:700}
.cref{font-size:6.5pt;text-align:right;font-weight:400} .ctitle{font-size:10pt;line-height:1.15;margin-top:.5mm}
.cardbody{display:flex;flex-direction:column;flex:1;min-height:0;font-size:8pt}
.cardbody>*{padding-left:0}
.cardbody>.fields,.cardbody>.checks,.cardbody>.yesno,.cardbody>.columns{padding:0 2mm}
.annexprev{display:flex;gap:3mm}

table.steps th,table.steps td{border:var(--line);padding:1.5mm 2mm;vertical-align:middle;text-align:left} table.steps th{background:var(--shade);text-align:center}
table.steps td.c{text-align:center;width:9mm} table.steps td.stx{width:46%} table.steps tr{break-inside:avoid}
table.steps tr.sec td{background:#e7e9ee;font-weight:700;text-align:center;padding:.6mm}
table.steps .dash{padding-left:3mm;text-indent:-3mm} table.steps td.sim{text-align:center;padding:1mm}
.annimg{position:relative;display:inline-block;line-height:0;max-width:100%} .annimg img{max-width:100%;max-height:62mm;height:auto;width:auto}
.annimg .an{position:absolute;box-sizing:border-box;line-height:1} .annimg .ellipse{border:.8mm solid #f00;border-radius:50%} .annimg .rect{border:.8mm solid #f00}
.annimg .label{font:700 11pt Arial,"Liberation Sans",sans-serif}

.list.indent{margin-left:7mm} .list.nested{margin-left:14mm}
.columns+.columns{margin-top:-.3mm}
table.kv:not(.bordered) th{text-align:left;font-style:normal;text-decoration:underline;width:22mm;padding:.5mm 2mm .5mm 0;vertical-align:top} table.kv:not(.bordered) td{padding:.5mm 0}
.area.shade b{background:#cfcfcf;padding:0 1mm}
.yesno.center{justify-content:center} .yesno.right{justify-content:flex-end;padding-right:2mm}
.cardbody>.text,.cardbody>p{padding:0 2mm;text-align:center;font-size:7.5pt}
`;

const SHEET_CSS = `
.sheet{break-after:page;position:relative;height:281mm;display:flex;flex-direction:column}
.sheet:last-child{break-after:auto}
.sgrid{display:grid;gap:7mm;flex:1;position:relative}
.sgrid{grid-template-columns:minmax(0,1fr)} .sgrid.g4{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))} .sgrid.g2{grid-template-rows:repeat(2,minmax(0,1fr))} .sgrid.g1{grid-template-rows:minmax(0,1fr)}
.sgrid.mirror{direction:rtl}
.sgrid.cut.g4::before,.sgrid.cut.g2::after{content:"";position:absolute;left:0;right:0;top:50%;border-top:.2mm dashed #999;pointer-events:none}
.sgrid.cut.g4::after{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:.2mm dashed #999;pointer-events:none}
.sfoot{display:flex;align-items:center;gap:3mm;height:14mm;font-size:7pt;color:#333;padding-top:2mm}
.sfoot .qr svg,.sfoot .qrph{width:11mm;height:11mm;display:block} .qrph{border:.2mm dashed #888;font-size:6pt;display:flex;align-items:center;justify-content:center;color:#888}
`;
const BASE = BASE_CSS + SHEET_CSS;

function printPageCss(doc, ctx) {
  const m = doc.meta;
  if (doc.kind === 'annex-card') return '@page{size:A4 portrait;margin:8mm}';
  const land = doc.layout?.orientation === 'landscape';
  const cols = visaColumns(doc, ctx);
  const cw = land ? 273 : 186; // largeur utile (mm) = page − marges latérales
  const mm = (x) => `${x.toFixed(3)}mm`;
  // Les cellules latérales doivent être symétriques : la cellule centrale est centrée sur la page.
  const wl = cw * 0.38, wr = wl, wc = cw - 2 * wl;
  const [bl, bc] = [cw / 3, cw / 3], br = cw - bl - bc;
  // Cellules à bordure ; latérales symétriques (la centrale est centrée sur la page), traits mitoyens sans doublon.
  const top = (txt, w, nl) => `box-sizing:border-box;border:.3mm solid #000;${nl ? 'border-left:0;' : ''}font:italic 9pt Arial,"Liberation Sans",sans-serif;text-align:center;vertical-align:middle;width:${w};content:${cssStr(txt)};`;
  const bot = (c, w) => `box-sizing:border-box;border:.3mm solid #000;font:italic 8pt Arial,"Liberation Sans",sans-serif;text-align:left;vertical-align:top;padding:1mm 2mm;white-space:pre;${w ? `width:${w};` : ''}content:${cssStr(c.join('\n'))};`;
  return `
@page{size:A4 ${land ? 'landscape' : 'portrait'};margin:15mm 12mm 14mm 12mm;
  @top-left{${top(m.society || '', mm(wl))}}
  @top-center{${top(`Réf : ${m.ref}      Vers : ${m.version}`, mm(wc), true)}}
  @top-right{${top('', mm(wr), true).replace('content:"";', 'content:"Page : " counter(page) " / " counter(pages);')}}
}
@page :first{margin-bottom:24mm;
  @bottom-left{${bot(cols[0], mm(bl))}}
  @bottom-center{${bot(cols[1], mm(bc))}border-left:0}
  @bottom-right{${bot(cols[2], mm(br))}border-left:0}
}
`;
}

// ───────────────────────── Assemblage ─────────────────────────

function bodyHtml(doc, ctx) {
  const c = { ...ctx, doc };
  if (doc.kind === 'annex-card') return renderSheets(doc, c);
  const inner = renderBlocks(doc.body, c);
  const marks = /class="li chg|class="blk changed/.test(inner); // gouttière pour les marques ☞
  return identification(doc) + `<main class="content${marks ? ' marks' : ''}">${inner}</main>`;
}

/** HTML complet destiné à Chromium pour produire le PDF (cartouche en boîtes de marge @page). */
export function renderPrintHtml(doc, ctx = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(doc.meta.ref)} v${doc.meta.version}</title><style>${BASE}${printPageCss(doc, ctx)}</style></head><body class="print">${bodyHtml(doc, ctx)}</body></html>`;
}

/** HTML d'aperçu à l'écran (éditeur). Le cartouche courant est simulé en haut de page ;
 *  la pagination exacte (x / N, bloc de visas en pied de page 1) est appliquée dans le PDF. */
export function renderScreenHtml(doc, ctx = {}) {
  const m = doc.meta;
  const land = doc.layout?.orientation === 'landscape';
  const w = doc.kind === 'annex-card' ? '210mm' : land ? '297mm' : '210mm';
  let page;
  if (doc.kind === 'annex-card') {
    page = bodyHtml(doc, ctx);
  } else {
    const head = `<table class="runhead"><tr><td style="width:38%">${esc(m.society || '')}</td><td style="width:22%">Réf : ${esc(m.ref)}&nbsp;&nbsp; Vers : ${m.version}</td><td>Page : 1 / N</td></tr></table>`;
    page = `<div class="paper">${head}${bodyHtml(doc, ctx)}<div class="vtop">${visaTable(doc, ctx)}</div></div>`;
  }
  const css = `${BASE}
body.screen{background:#d8dce2;padding:6mm 0}
.paper{width:${w};margin:0 auto 6mm;background:#fff;padding:12mm;box-shadow:0 1px 6px rgba(0,0,0,.25);min-height:${land ? '210mm' : '297mm'}}
.runhead{margin:-3mm 0 0} .runhead td{border:var(--line);text-align:center;font:italic 9pt Arial,sans-serif;padding:2mm}
.vtop{margin-top:8mm}
.sheet{background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25);margin:0 auto 6mm;padding:8mm;height:297mm;width:210mm}
.rep.newpage{break-before:auto;margin-top:12mm;padding-top:6mm;border-top:.3mm dashed #aab}
.card.fixed{box-shadow:0 0 0 .2mm #aaa}`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${css}</style></head><body class="screen">${page}</body></html>`;
}
