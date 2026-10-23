"""Orchestration : modele PDF + image recue -> resultat de controle."""
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from .. import config
from . import barcodes, imaging, textcmp, visual


@dataclass
class Result:
    statut: str
    score_global: float
    ecarts: list[dict]
    texte_modele: str
    texte_recu: str
    codes: dict
    scores: dict
    aligne: bool
    overlay: np.ndarray = field(repr=False, default=None)
    model_img: np.ndarray = field(repr=False, default=None)
    recv_aligned: np.ndarray = field(repr=False, default=None)


def _drop_blank(cover: np.ndarray, recv: np.ndarray, model: np.ndarray) -> np.ndarray:
    """Zones du scan restees blanches (papier nu) la ou le modele est imprime : partie non scannee/non imprimee."""
    white = lambda im: (cv2.GaussianBlur(im, (0, 0), 3) > 238).all(axis=2).astype(np.uint8)
    blank = cv2.morphologyEx(white(recv) & (1 - white(model)), cv2.MORPH_OPEN, np.ones((41, 41), np.uint8))
    # Une marge blanche du modele hors du scan n'est pas une partie manquante (le scan est detoure sur l'encre).
    cover = np.where(white(model) > 0, 255, cover)
    return np.where(blank > 0, 0, cover).astype(np.uint8)


def _split_uncovered(ecarts: list[dict], cover: np.ndarray) -> tuple[list[dict], dict | None]:
    """Regroupe en un seul ecart tout ce qui tombe dans la partie de l'etiquette absente du scan."""
    solid = cv2.erode((cover > 127).astype(np.uint8), np.ones((15, 15), np.uint8))
    missing_ratio = 1 - float(solid.mean())
    if missing_ratio < 0.03:
        return ecarts, None
    keep = []
    for e in ecarts:
        z = e["zone"].split(",")
        if len(z) == 4:
            x, y, w, h = (int(v) for v in z)
            if not solid[min(y + h // 2, solid.shape[0] - 1), min(x + w // 2, solid.shape[1] - 1)]:
                continue
        keep.append(e)
    ys, xs = np.where(solid == 0)
    box = f"{xs.min()},{ys.min()},{xs.max() - xs.min()},{ys.max() - ys.min()}"
    return keep, {"zone": box, "type_ecart": "partie_non_scannee", "criticite": 3,
                  "valeur_attendue": "etiquette entiere",
                  "valeur_trouvee": f"{missing_ratio * 100:.0f} % de l'etiquette absent du scan (scan coupe ou etiquette mal posee)"}


@lru_cache(maxsize=16)
def _model_bundle(path: str, mtime_ns: int):
    """Tout ce qui ne depend que du modele (rendu, points ORB, zones de texte, codes-barres) : calcule une fois."""
    img = imaging.load_model(Path(path), config.RENDER_DPI)
    f = config.WORK_SIZE / max(img.shape[:2])  # taille de travail fixe : OCR/comparaison sur une echelle stable
    img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC if f > 1 else cv2.INTER_AREA)
    return img, visual.model_features(img), textcmp.text_regions(img), barcodes.read(img)


def run(model_pdf: Path, image: np.ndarray, langs: str | None = None,
        model_lang: str | None = None, label_lang: str | None = None, use_ocr: bool | None = None) -> Result:
    use_ocr = config.USE_OCR if use_ocr is None else use_ocr
    model_img, features, regions, expected_codes = _model_bundle(str(model_pdf), model_pdf.stat().st_mtime_ns)
    recv = imaging.normalize_received(image, max(model_img.shape[:2]))
    recv_aligned, aligned, cover = visual.align(recv, model_img, features)

    recv_aligned, color_shift = visual.match_colors(recv_aligned, model_img, cover)
    cover = _drop_blank(cover, recv_aligned, model_img)
    model_cmp = visual.match_sharpness(model_img, recv_aligned)  # le modele n'est plus net que le scan

    if use_ocr:
        model_words = textcmp.ocr_words(model_img, langs)
        recv_words = textcmp.ocr_words(recv_aligned, langs)
        native = imaging.pdf_text(model_pdf).strip()
        # Beaucoup de PDF d'imprimeur ont le texte vectorise : peu de texte natif => on s'appuie sur l'OCR.
        model_text = native if len(native.split()) >= 15 else textcmp.words_to_text(model_words)
        recv_text = textcmp.words_to_text(recv_words)
        if model_lang and label_lang and model_lang != label_lang:
            recv_text = textcmp.translate(recv_text, label_lang, model_lang)
        text_ecarts, text_sim = textcmp.compare_words(model_words, recv_words, model_img, recv_aligned)
    else:  # comparaison d'images : aucune langue a installer
        model_text = recv_text = ""
        text_ecarts, text_sim = textcmp.compare_regions(regions, model_cmp, recv_aligned)
    code_ecarts, codes = barcodes.compare(model_img, recv_aligned, image, expected=expected_codes)
    vis_ecarts, ssim, overlay = visual.diff(model_cmp, recv_aligned)

    col_ecarts = visual.color_diff(model_cmp, recv_aligned, overlay)
    ecarts = code_ecarts + text_ecarts + vis_ecarts + col_ecarts
    if color_shift > 0.2:  # transformation de couleur tres forte : toute l'etiquette a une autre teinte
        ecarts.append({"zone": "etiquette", "type_ecart": "couleur_globale", "criticite": 2,
                       "valeur_attendue": "teinte du modele", "valeur_trouvee": f"teinte globale tres differente (ecart {color_shift:.2f})"})
    ecarts, missing = _split_uncovered(ecarts, cover)
    if missing:
        ecarts.insert(0, missing)
    mismatch = not aligned or (text_sim < 0.3 and ssim < 0.7)  # le recalage a pu s'accrocher au logo commun
    if mismatch:
        ecarts.insert(0, {"zone": "etiquette", "type_ecart": "etiquette_non_reconnue", "criticite": 3,
                          "valeur_attendue": "etiquette correspondant au modele",
                          "valeur_trouvee": "impossible de recaler l'image sur le modele (mauvais modele, image floue ou trop partielle ?)"})
    ecarts = sorted(ecarts, key=lambda e: -e["criticite"])[:100]
    worst = max((e["criticite"] for e in ecarts), default=0)
    statut = "CONFORME" if worst == 0 else "A_REVOIR" if worst == 1 else "NON_CONFORME"
    barcode_ok = 0.0 if code_ecarts else 1.0
    score = round(100 * (0.5 * text_sim + 0.3 * max(ssim, 0) + 0.2 * barcode_ok), 1)
    return Result(statut, score, ecarts, model_text, recv_text, codes,
                  {"texte": round(text_sim, 3), "ssim": round(ssim, 3)}, aligned, overlay, model_img, recv_aligned)
