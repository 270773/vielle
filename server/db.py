"""Persistance SQLite (schema aligne sur le dossier technique ; SQL Server en production)."""
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS utilisateurs(id INTEGER PRIMARY KEY, login_ad TEXT UNIQUE, nom TEXT, prenom TEXT,
  role TEXT, actif INTEGER DEFAULT 1, date_creation TEXT);
CREATE TABLE IF NOT EXISTS modeles_pdf(id INTEGER PRIMARY KEY, ref_produit TEXT, fournisseur TEXT, langue TEXT,
  version TEXT, date_validation TEXT, chemin_reseau TEXT UNIQUE, hash_md5 TEXT, langues_ocr TEXT DEFAULT '',
  nom_produit TEXT DEFAULT '', code_etiquette TEXT DEFAULT '', ean TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS controles(id INTEGER PRIMARY KEY, date_heure TEXT, utilisateur_id TEXT,
  modele_id INTEGER REFERENCES modeles_pdf(id), image_path TEXT, overlay_path TEXT, statut TEXT,
  score_global REAL, detail_json TEXT);
CREATE TABLE IF NOT EXISTS ecarts(id INTEGER PRIMARY KEY, controle_id INTEGER REFERENCES controles(id), zone TEXT,
  type_ecart TEXT, criticite INTEGER, valeur_attendue TEXT, valeur_trouvee TEXT);
CREATE TABLE IF NOT EXISTS validations(id INTEGER PRIMARY KEY, controle_id INTEGER REFERENCES controles(id),
  utilisateur_id TEXT, date TEXT, decision TEXT, commentaire TEXT, signature_hash TEXT);
CREATE TABLE IF NOT EXISTS rapports(id INTEGER PRIMARY KEY, controle_id INTEGER REFERENCES controles(id),
  chemin_pdf TEXT, date_generation TEXT, hash_sha256 TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, date_heure TEXT, utilisateur_id TEXT, action TEXT,
  details TEXT, ip TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log immuable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log immuable'); END;
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def conn():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        cols = [r["name"] for r in c.execute("PRAGMA table_info(modeles_pdf)")]
        for col in ("langues_ocr", "nom_produit", "code_etiquette", "ean"):
            if col not in cols:
                c.execute(f"ALTER TABLE modeles_pdf ADD COLUMN {col} TEXT DEFAULT ''")


def audit(c, user: str, action: str, details: str = "", ip: str = "") -> None:
    c.execute("INSERT INTO audit_log(date_heure,utilisateur_id,action,details,ip) VALUES(?,?,?,?,?)",
              (now(), user, action, details, ip))


def sign(controle_id: int, user: str, decision: str, date: str) -> str:
    return hashlib.sha256(f"{controle_id}|{user}|{decision}|{date}".encode()).hexdigest()


_CODE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{1,2}\d{5,7}|\d{6})(?![A-Za-z0-9])")
_NOISE = re.compile(r"^(etiq|etiquette|quadri|cmyk|bat|pdf|v\d+|\d{4}|\d+x\d+|cp\d+kg|\d+kg|\d+g)$", re.I)


def parse_name(stem: str) -> tuple[str, str]:
    """Nom de produit et codes d'etiquette deduits d'un nom de fichier d'imprimeur.

    '737042-2022-150x210-quadri-ETIQ_INVENTIS_PREMIX_RUSTIC_5__F701007_RUSC_CP10kg'
    -> ('INVENTIS PREMIX RUSTIC 5', '737042 F701007')"""
    parts = re.split(r"[_\-\s]+", stem)
    codes = []
    for m in _CODE.finditer(" ".join(parts)):
        if m.group(1) not in codes:
            codes.append(m.group(1))
    words = [w for w in parts if w and w not in codes and not _NOISE.match(w)]
    return " ".join(words).strip(), " ".join(codes)


def sync_models() -> int:
    """Indexe tous les modeles (PDF ou image) du dossier reseau PDF_ROOT, a n'importe quelle profondeur.

    Les metadonnees (nom du produit, code d'etiquette) viennent du nom du fichier ou, si present, d'un
    fichier <nom>.json voisin : {"nom": "...", "code": "...", "langue": "tr"}."""
    from .engine.imaging import MODEL_EXT
    n = 0
    with conn() as c:
        for f in sorted(p for p in config.PDF_ROOT.rglob("*") if p.is_file() and p.suffix.lower() in MODEL_EXT):
            rel = f.relative_to(config.PDF_ROOT).parts
            md5 = hashlib.md5(f.read_bytes()).hexdigest()
            side = f.with_suffix(".json")
            meta = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {}
            structured = len(rel) == 4 and f.stem.lower() == "modele"  # {Fournisseur}/{Reference}/{Version}/modele.pdf
            nom, code = parse_name(f.stem if not structured else rel[1])
            nom, code = meta.get("nom", nom), meta.get("code", code)
            fournisseur = rel[0] if len(rel) > 1 else ""
            ref = rel[1] if structured else (code.split(" ")[-1] if code else f.stem)
            version = rel[2] if structured else (re.search(r"[Vv](\d+)", f.stem) or [None, "1"])[1]
            langue = meta.get("langue", "fr")
            ocr = ",".join(meta.get("langues_etiquette", [langue, "en"]))
            row = c.execute("SELECT id, hash_md5 FROM modeles_pdf WHERE chemin_reseau=?", (str(f),)).fetchone()
            if row is None:
                c.execute("INSERT INTO modeles_pdf(ref_produit,fournisseur,langue,version,date_validation,chemin_reseau,hash_md5,"
                          "langues_ocr,nom_produit,code_etiquette) VALUES(?,?,?,?,?,?,?,?,?,?)",
                          (ref, fournisseur, langue, version, now(), str(f), md5, ocr, nom, code))
                n += 1
            elif row["hash_md5"] != md5:  # modele remplace : l'EAN et l'empreinte visuelle sont a recalculer
                c.execute("UPDATE modeles_pdf SET hash_md5=?, ean='', nom_produit=?, code_etiquette=? WHERE id=?",
                          (md5, nom, code, row["id"]))
    return n


def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False)
