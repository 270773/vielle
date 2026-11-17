// Serveur de démonstration : API documents + workflow de visa + rendu PDF.
// Dans la GED réelle, ce module est remplacé par les services de la GED (stockage, droits, annuaire) :
// seuls src/render.js, src/workflow.js et schema/ sont à réutiliser tels quels.

import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import qrcode from 'qrcode-generator';
import { renderPrintHtml } from './src/render.js';
import { sign, revise, verifyIntegrity, nextStep, changedBlockIds, WorkflowError } from './src/workflow.js';
import { seed } from './seed/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const require = createRequire(import.meta.url);

const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(await readFile(join(ROOT, 'schema/document.schema.json'), 'utf8')));
const REF = /^[A-Za-z0-9._-]+$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ───────────── stockage (fichiers JSON ; à remplacer par la GED) ─────────────
const docDir = (ref) => { if (!REF.test(ref)) throw new HttpError(400, 'Référence invalide'); return join(DATA, 'documents', ref); };
async function versions(ref) {
  try { return (await readdir(docDir(ref))).map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b); }
  catch { return []; }
}
async function load(ref, v) {
  const vs = await versions(ref);
  if (!vs.length) throw new HttpError(404, `Document ${ref} introuvable`);
  const n = v ? Number(v) : vs[vs.length - 1];
  if (!vs.includes(n)) throw new HttpError(404, `Version ${n} de ${ref} introuvable`);
  return JSON.parse(await readFile(join(docDir(ref), `v${n}.json`), 'utf8'));
}
async function prevVersion(doc) {
  const before = (await versions(doc.meta.ref)).filter((n) => n < doc.meta.version);
  return before.length ? load(doc.meta.ref, Math.max(...before)) : null;
}
async function save(doc) {
  const bad = !validate(doc);
  if (bad) throw new HttpError(422, 'Document non conforme au schéma : ' + validate.errors.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join(' ; '));
  await mkdir(docDir(doc.meta.ref), { recursive: true });
  await writeFile(join(docDir(doc.meta.ref), `v${doc.meta.version}.json`), JSON.stringify(doc, null, 2));
}
const users = async () => JSON.parse(await readFile(join(DATA, 'users.json'), 'utf8'));
async function allLatest() {
  const refs = await readdir(join(DATA, 'documents')).catch(() => []);
  const out = {};
  for (const r of refs) out[r] = await load(r);
  return out;
}

// ───────────── rendu ─────────────
const origin = (req) => `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
const qrSvg = (url) => { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }); };

async function renderCtx(req, doc) {
  const prev = await prevVersion(doc);
  return { docs: await allLatest(), users: await users(), gedUrl: (r) => `${origin(req)}/?doc=${encodeURIComponent(r)}`, qr: qrSvg, changed: changedBlockIds(prev, doc) };
}

let browserP;
async function browser() {
  if (!browserP) {
    let chromium;
    try { ({ chromium } = require('playwright')); } catch { throw new HttpError(501, 'Playwright n’est pas installé : export PDF indisponible.'); }
    browserP = chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}).then((b) => { b.on('disconnected', () => { browserP = null; }); return b; });
    browserP.catch(() => { browserP = null; });
  }
  return browserP;
}
async function pdfFromUrl(url) {
  const ctx = await (await browser()).newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally { await ctx.close(); }
}
const tmp = new Map(); // html temporaire pour le PDF d'un brouillon non enregistré
function stash(html) { const id = randomUUID(); tmp.set(id, html); setTimeout(() => tmp.delete(id), 60_000).unref(); return id; }

// ───────────── HTTP ─────────────
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function readBody(req, limit = 5_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Corps trop volumineux'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const readJson = async (req) => { try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'JSON invalide'); } };

async function serveFile(res, base, rel) {
  const file = normalize(join(base, rel));
  if (!file.startsWith(base + sep)) throw new HttpError(403, 'Interdit');
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
  return true;
}

const summary = async (ref) => {
  const vs = await versions(ref); const d = await load(ref);
  return { ref, kind: d.kind, title: d.meta.title.replace(/\n/g, ' '), version: d.meta.version, status: d.status, versions: vs };
};

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // après /api
  const m = req.method;
  const v = url.searchParams.get('v');

  if (m === 'GET' && parts[0] === 'users') return json(res, 200, await users());
  if (m === 'GET' && parts[0] === 'catalog') return json(res, 200, { docs: await allLatest(), users: await users() });

  if (parts[0] === 'documents' && parts.length === 1 && m === 'GET') {
    const refs = (await readdir(join(DATA, 'documents')).catch(() => [])).sort();
    return json(res, 200, await Promise.all(refs.map(summary)));
  }

  if (parts[0] === 'documents' && parts[1]) {
    const ref = parts[1], action = parts[2];
    if (m === 'GET' && !action) {
      const doc = await load(ref, v);
      const prev = await prevVersion(doc);
      return json(res, 200, { doc, integrity: verifyIntegrity(doc), nextStep: nextStep(doc), changed: [...changedBlockIds(prev, doc)], versions: await versions(ref) });
    }
    if (m === 'PUT' && !action) {
      const incoming = await readJson(req);
      if (incoming?.meta?.ref !== ref) throw new HttpError(400, 'La référence ne peut pas être modifiée.');
      const current = await load(ref, incoming.meta.version).catch(() => null);
      if (!current) throw new HttpError(404, 'Version inconnue : créez-la par « Nouvelle version ».');
      if (current.status !== 'brouillon') throw new HttpError(409, `Version ${current.meta.version} au statut « ${current.status} » : non modifiable. Créez une nouvelle version.`);
      // Les données posées par la GED ne sont jamais écrasées par l'éditeur.
      const doc = { ...incoming, status: current.status, visas: current.visas, workflow: current.workflow, meta: { ...incoming.meta, ref, version: current.meta.version, created: current.meta.created, effective: current.meta.effective, annule: current.meta.annule } };
      await save(doc);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && action === 'visa') {
      const { user } = await readJson(req);
      const next = sign(await load(ref, v), user, await users());
      await save(next);
      if (next.status === 'en_vigueur' && next.meta.version > 1) { // la version précédente est annulée
        const old = await load(ref, next.meta.version - 1).catch(() => null);
        if (old && old.status === 'en_vigueur') await save({ ...old, status: 'annule' });
      }
      return json(res, 200, { doc: next });
    }
    if (m === 'POST' && action === 'revise') {
      const next = revise(await load(ref));
      await save(next);
      return json(res, 201, { doc: next });
    }
    if (m === 'GET' && action === 'print.html') {
      const doc = await load(ref, v);
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(renderPrintHtml(doc, await renderCtx(req, doc)));
    }
    if (m === 'GET' && action === 'pdf') {
      const doc = await load(ref, v);
      const pdf = await pdfFromUrl(`${origin(req)}/api/documents/${encodeURIComponent(ref)}/print.html?v=${doc.meta.version}`);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${ref}-v${doc.meta.version}.pdf"` });
      return res.end(pdf);
    }
  }

  // PDF d'un brouillon en cours d'édition (non enregistré)
  if (m === 'POST' && parts[0] === 'render' && parts[1] === 'pdf') {
    const doc = await readJson(req);
    if (!validate(doc)) throw new HttpError(422, 'Document non conforme au schéma');
    const id = stash(renderPrintHtml(doc, await renderCtx(req, doc)));
    const pdf = await pdfFromUrl(`${origin(req)}/api/tmp/${id}.html`);
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end(pdf);
  }
  if (m === 'GET' && parts[0] === 'tmp') {
    const html = tmp.get((parts[1] || '').replace(/\.html$/, ''));
    if (!html) throw new HttpError(404, 'Expiré');
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(html);
  }

  // Dépôt d'images (photos des documents)
  if (m === 'POST' && parts[0] === 'assets') {
    const type = (req.headers['content-type'] || '').split(';')[0];
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type];
    if (!ext) throw new HttpError(415, 'Image JPEG, PNG, GIF ou WebP uniquement.');
    const buf = await readBody(req, 12_000_000);
    const name = `${randomUUID()}${ext}`;
    await mkdir(join(DATA, 'assets'), { recursive: true });
    await writeFile(join(DATA, 'assets', name), buf);
    return json(res, 201, { src: `/assets/${name}` });
  }

  throw new HttpError(404, 'Route inconnue');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/assets/')) {
      if (await serveFile(res, join(DATA, 'assets'), p.slice('/assets/'.length))) return;
      if (await serveFile(res, join(ROOT, 'public', 'assets'), p.slice('/assets/'.length))) return;
    } else if (p.startsWith('/src/')) {
      if (await serveFile(res, join(ROOT, 'src'), p.slice('/src/'.length))) return;
    } else if (await serveFile(res, join(ROOT, 'public'), p === '/' ? 'index.html' : p.slice(1))) return;
    throw new HttpError(404, 'Introuvable');
  } catch (e) {
    const status = e.status || (e instanceof WorkflowError ? 409 : 500);
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    json(res, status, { error: e.message });
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await (await browserP)?.close(); } catch { /* déjà fermé */ } process.exit(0); });
}

await seed(); // ne crée que ce qui manque
server.listen(PORT, () => console.log(`Éditeur GED → http://localhost:${PORT}`));
