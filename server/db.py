"""Persistance SQLite (schema aligne sur le dossier technique ; SQL Server en production)."""
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS utilisateurs(id INTEGER PRIMARY KEY, login_ad TEXT UNIQUE, nom TEXT, prenom TEXT,
  role TEXT, actif INTEGER DEFAULT 1, date_creation TEXT);
CREATE TABLE IF NOT EXISTS modeles_pdf(id INTEGER PRIMARY KEY, ref_produit TEXT, fournisseur TEXT, langue TEXT,
  version TEXT, date_validation TEXT, chemin_reseau TEXT UNIQUE, hash_md5 TEXT);
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


def audit(c, user: str, action: str, details: str = "", ip: str = "") -> None:
    c.execute("INSERT INTO audit_log(date_heure,utilisateur_id,action,details,ip) VALUES(?,?,?,?,?)",
              (now(), user, action, details, ip))


def sign(controle_id: int, user: str, decision: str, date: str) -> str:
    return hashlib.sha256(f"{controle_id}|{user}|{decision}|{date}".encode()).hexdigest()


def sync_models() -> int:
    """Indexe {Fournisseur}/{Reference}/{Version}/modele.pdf depuis PDF_ROOT."""
    n = 0
    with conn() as c:
        for pdf in sorted(config.PDF_ROOT.glob("*/*/*/modele.pdf")):
            fournisseur, ref, version = pdf.parts[-4:-1]
            md5 = hashlib.md5(pdf.read_bytes()).hexdigest()
            row = c.execute("SELECT id, hash_md5 FROM modeles_pdf WHERE chemin_reseau=?", (str(pdf),)).fetchone()
            if row is None:
                c.execute("INSERT INTO modeles_pdf(ref_produit,fournisseur,langue,version,date_validation,chemin_reseau,hash_md5)"
                          " VALUES(?,?,?,?,?,?,?)", (ref, fournisseur, "fr", version, now(), str(pdf), md5))
                n += 1
            elif row["hash_md5"] != md5:
                c.execute("UPDATE modeles_pdf SET hash_md5=? WHERE id=?", (md5, row["id"]))
    return n


def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False)
