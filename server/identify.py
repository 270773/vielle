"""Identification automatique du modele a partir de l'etiquette recue.

Deux signaux, tous deux independants de la langue :
  1. le code-barres (EAN/QR) lu sur l'etiquette, compare a ceux des modeles ;
  2. la ressemblance visuelle (points ORB + homographie RANSAC) avec chaque modele.
Une requete texte optionnelle (nom du produit, code d'etiquette) restreint et departage les candidats.
"""
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from . import config, db
from .engine import barcodes, imaging

ID_SIZE = 1000   # taille de travail de l'identification (plus petite que la comparaison : il faut aller vite)
SURE_INLIERS = 35


def _fold(t: str) -> str:
    t = unicodedata.normalize("NFKD", t)
    return "".join(c for c in t if not unicodedata.combining(c)).casefold()


def _tokens(t: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", _fold(t)) if w]


@lru_cache(maxsize=512)
def _model_signature(path: str, mtime_ns: int):
    """(EAN du modele, descripteurs ORB) : calcule une seule fois par modele."""
    img = imaging.load_model(Path(path), config.RENDER_DPI)
    f = ID_SIZE / max(img.shape[:2])
    img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    kp, des = cv2.ORB_create(1500).detectAndCompute(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None)
    pts = np.float32([k.pt for k in kp]) if kp else np.zeros((0, 2), np.float32)
    big = imaging.load_model(Path(path), config.RENDER_DPI)
    codes = [v for _, v in barcodes.read(big)]
    return codes, pts, des


def _inliers(des_a, pts_a, des_b, pts_b) -> int:
    if des_a is None or des_b is None or len(des_a) < 20 or len(des_b) < 20:
        return 0
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(des_a, des_b, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 12:
        return 0
    src = pts_a[[m.queryIdx for m in good]].reshape(-1, 1, 2)
    dst = pts_b[[m.trainIdx for m in good]].reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 6.0)
    return int(mask.sum()) if H is not None else 0


def identify(image: np.ndarray, query: str = "", limit: int = 5) -> dict:
    """Classe les modeles par ressemblance avec `image`.

    Retourne {"candidats": [...], "sur": bool}. `sur` = un seul candidat nettement au-dessus des autres."""
    db.sync_models()
    with db.conn() as c:
        models = [dict(r) for r in c.execute("SELECT * FROM modeles_pdf")]
    q = _tokens(query)
    if q:
        hay = lambda m: _tokens(f"{m['nom_produit']} {m['code_etiquette']} {m['ref_produit']} {m['fournisseur']}")
        filtered = [m for m in models if all(any(t in h or h in t for h in hay(m)) for t in q)]
        models = filtered or models  # une requete sans resultat ne doit pas cacher les modeles

    recv = imaging.normalize_received(image, ID_SIZE)
    kp, des = cv2.ORB_create(1500).detectAndCompute(cv2.cvtColor(recv, cv2.COLOR_BGR2GRAY), None)
    pts = np.float32([k.pt for k in kp]) if kp else np.zeros((0, 2), np.float32)
    seen = {v for _, v in barcodes.read(image)} | {v for _, v in barcodes.read(recv)}

    out = []
    for m in models:
        p = Path(m["chemin_reseau"])
        codes, mpts, mdes = _model_signature(str(p), p.stat().st_mtime_ns)
        if codes and not m["ean"]:
            with db.conn() as c:
                c.execute("UPDATE modeles_pdf SET ean=? WHERE id=?", (",".join(codes), m["id"]))
        ean_ok = bool(seen & set(codes))
        inl = _inliers(des, pts, mdes, mpts)
        score = inl + (60 if ean_ok else 0)
        raison = ["code-barres identique"] if ean_ok else []
        if inl >= 12:
            raison.append(f"{inl} points visuels communs")
        if q:
            raison.append("correspond a la recherche")
        out.append({"modele_id": m["id"], "nom": m["nom_produit"] or m["ref_produit"], "code": m["code_etiquette"],
                    "fournisseur": m["fournisseur"], "score": score, "inliers": inl, "ean": ean_ok, "raison": raison})
    out.sort(key=lambda r: -r["score"])
    top = out[:limit]
    dominant = bool(top) and (len(top) == 1 or top[0]["score"] >= 1.6 * top[1]["score"])
    only_ean = bool(top) and top[0]["ean"] and sum(r["ean"] for r in out) == 1  # un seul modele porte ce code-barres
    # Un code-barres lu et propre a un seul modele est decisif (des etiquettes d'une meme famille se ressemblent).
    sure = bool(top) and ((only_ean and top[0]["inliers"] >= 12) or (dominant and top[0]["inliers"] >= SURE_INLIERS))
    return {"candidats": top, "sur": sure}
