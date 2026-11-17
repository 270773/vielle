#!/usr/bin/env node
// Migration Word → JSON GED.
//   node tools/migrate/cli.js <fichier.doc|.docx>… [--out data/documents] [--assets data/assets] [--legacy-visas] [--force]
// Les .doc (Word 97-2003) sont d'abord convertis en .docx par LibreOffice (soffice).

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { convertDocx } from './docx.js';
import { contentHash } from '../../src/workflow.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flagOn = (n) => args.includes(n);
const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--assets'].includes(args[i - 1]));
const OUT = resolve(opt('--out', 'data/documents')), ASSETS = resolve(opt('--assets', 'data/assets'));
const exists = (p) => access(p).then(() => true, () => false);

async function toDocx(file) {
  if (extname(file).toLowerCase() === '.docx') return file;
  const dir = await mkdtemp(join(tmpdir(), 'migrate-'));
  const src = join(dir, basename(file)); await copyFile(file, src);
  try { execFileSync('soffice', ['--headless', '--convert-to', 'docx', '--outdir', dir, src], { stdio: 'ignore', timeout: 120000 }); }
  catch { throw new Error(`Conversion .doc → .docx impossible (LibreOffice « soffice » requis) : ${file}`); }
  return join(dir, basename(file, extname(file)) + '.docx');
}

const icon = { todo: '✗ À REPRENDRE', warn: '! Réserve', info: 'i' };
const rows = [];
for (const f of files) {
  const docxPath = await toDocx(f);
  const { doc, report, assets } = await convertDocx(await readFile(docxPath), { source: basename(f), assetBase: '/assets/migrated/__B__' });
  const base = `${doc.meta.ref}-v${doc.meta.version}`;
  let json = JSON.stringify(doc, null, 2).replaceAll('__B__', base);
  const out = JSON.parse(json);
  if (flagOn('--legacy-visas')) {
    out.status = 'en_vigueur'; const h = contentHash(out);
    out.visas = out.meta.migration.legacy.map((v) => ({ ...v, hash: h, origin: 'migration' }));
    out.meta.effective = out.meta.effective || out.meta.created;
  }
  const file = join(OUT, doc.meta.ref, `v${doc.meta.version}.json`);
  if (!flagOn('--force') && (await exists(file))) { console.log(`= ${basename(f)} : ${file} existe déjà (--force pour écraser)`); continue; }
  await mkdir(join(OUT, doc.meta.ref), { recursive: true }); await writeFile(file, JSON.stringify(out, null, 2));
  await mkdir(join(ASSETS, 'migrated', base), { recursive: true });
  for (const a of assets) await writeFile(join(ASSETS, 'migrated', base, a.name), a.data);

  const c = report.counts;
  console.log(`\n■ ${basename(f)} → ${doc.meta.ref} v${doc.meta.version}  (${out.status}, ${doc.layout.orientation})`);
  console.log(`  cartouche : ${report.flags.some((x) => /^Cartouche/.test(x.message)) ? 'incomplet' : 'complet'} · ${c.paragraphs} paragraphes (${c.textChars} car.) · ${c.lists} listes · ${c.tables} tableaux (${c.stepsTables} d'étapes, ${c.layoutTables} de mise en page) · ${c.images} images · ${c.annotations} annotations`);
  console.log(`  blocs : ${Object.entries(report.blocks).map(([k, v]) => `${k}×${v}`).join(', ') || 'aucun'}`);
  for (const fl of report.flags) console.log(`  ${icon[fl.level]} : ${fl.message}`);
  rows.push({ f: basename(f), ref: doc.meta.ref, ...c, todo: report.flags.filter((x) => x.level === 'todo').length });
}
if (!files.length) console.log('Usage : node tools/migrate/cli.js <fichier.doc|.docx>… [--out dir] [--assets dir] [--legacy-visas] [--force]');
