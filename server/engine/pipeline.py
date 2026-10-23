"""Orchestration : modele PDF + image recue -> resultat de controle."""
from dataclasses import dataclass, field
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


def run(model_pdf: Path, image: np.ndarray, langs: str | None = None,
        model_lang: str | None = None, label_lang: str | None = None) -> Result:
    model_img = imaging.load_model(model_pdf, config.RENDER_DPI)
    if max(model_img.shape[:2]) < config.WORK_SIZE:  # modele image basse resolution : on agrandit pour l'OCR
        f = config.WORK_SIZE / max(model_img.shape[:2])
        model_img = cv2.resize(model_img, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    recv = imaging.normalize_received(image, max(model_img.shape[:2]))
    recv_aligned, aligned = visual.align(recv, model_img)

    recv_aligned = visual.match_colors(recv_aligned, model_img)

    model_words = textcmp.ocr_words(model_img, langs)
    recv_words = textcmp.ocr_words(recv_aligned, langs)
    model_text = imaging.pdf_text(model_pdf).strip() or textcmp.words_to_text(model_words)
    recv_text = textcmp.words_to_text(recv_words)
    if model_lang and label_lang and model_lang != label_lang:
        recv_text = textcmp.translate(recv_text, label_lang, model_lang)

    text_ecarts, text_sim = textcmp.compare_words(model_words, recv_words, model_img, recv_aligned)
    code_ecarts, codes = barcodes.compare(model_img, recv_aligned)
    vis_ecarts, ssim, overlay = visual.diff(model_img, recv_aligned)

    ecarts = code_ecarts + text_ecarts + vis_ecarts
    worst = max((e["criticite"] for e in ecarts), default=0)
    statut = "CONFORME" if worst == 0 else "A_REVOIR" if worst == 1 else "NON_CONFORME"
    barcode_ok = 0.0 if code_ecarts else 1.0
    score = round(100 * (0.5 * text_sim + 0.3 * max(ssim, 0) + 0.2 * barcode_ok), 1)
    return Result(statut, score, ecarts, model_text, recv_text, codes,
                  {"texte": round(text_sim, 3), "ssim": round(ssim, 3)}, aligned, overlay)
