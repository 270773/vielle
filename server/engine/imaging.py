"""Chargement du modele PDF et pretraitement de l'image de l'etiquette recue."""
from pathlib import Path

import cv2
import numpy as np
import pymupdf


IMAGE_EXT = {".png", ".bmp", ".jpg", ".jpeg", ".tif", ".tiff"}
MODEL_EXT = {".pdf"} | IMAGE_EXT


def load_model(path: Path, dpi: int) -> np.ndarray:
    """Modele de reference : PDF (rendu a `dpi`) ou image (BMP, PNG, JPEG, TIFF)."""
    if path.suffix.lower() == ".pdf":
        img = render_pdf(path, dpi)
        with pymupdf.open(path) as doc:
            has_trim = doc[0].trimbox != doc[0].mediabox
        # Sans TrimBox, un PDF d'imprimeur porte repères de coupe et ligne de slug : on ne garde que l'artwork.
        return img if has_trim else crop_to_label(img, max_fraction=1.0, margin=0)
    return decode_image(path.read_bytes())


def _trim(page) -> "pymupdf.Rect":
    """Zone utile : TrimBox du PDF si presente (exclut reperes de coupe, fonds perdus et ligne de slug)."""
    return page.trimbox if page.trimbox != page.mediabox else page.rect


def render_pdf(path: Path, dpi: int, page: int = 0) -> np.ndarray:
    with pymupdf.open(path) as doc:
        pix = doc[page].get_pixmap(dpi=dpi, alpha=False, clip=_trim(doc[page]))
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def pdf_text(path: Path, page: int = 0) -> str:
    """Texte natif du PDF (vide si le PDF est une image ou si le modele est une image)."""
    if path.suffix.lower() != ".pdf":
        return ""
    with pymupdf.open(path) as doc:
        return doc[page].get_text("text", clip=_trim(doc[page]))


def decode_image(data: bytes) -> np.ndarray:
    if data[:5] == b"%PDF-":  # scan enregistre en PDF par le scanner : 1re page
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            pix = doc[0].get_pixmap(dpi=300, alpha=False)
            return cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n), cv2.COLOR_RGB2BGR)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Image illisible (formats acceptes : PNG, JPEG, TIFF, BMP)")
    return img


def crop_to_label(img: np.ndarray, min_fraction: float = 0.04, max_fraction: float = 0.9, margin: int = 12) -> np.ndarray:
    """Scan A4 : isole l'etiquette (tout ce qui differe du fond de la vitre/du capot)."""
    h, w = img.shape[:2]
    small = cv2.resize(img, None, fx=800 / max(h, w), fy=800 / max(h, w), interpolation=cv2.INTER_AREA)
    border = np.concatenate([small[:5].reshape(-1, 3), small[-5:].reshape(-1, 3),
                             small[:, :5].reshape(-1, 3), small[:, -5:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    mask = (np.abs(small.astype(int) - bg).max(axis=2) > 28).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    # union de tous les blocs significatifs (une etiquette est faite de plusieurs elements disjoints)
    cnts = [c for c in cnts if cv2.contourArea(c) > 0.0005 * mask.size]
    if not cnts:
        return img
    x, y, bw, bh = cv2.boundingRect(np.concatenate(cnts))
    frac = bw * bh / (small.shape[0] * small.shape[1])
    if frac < min_fraction or frac > max_fraction:  # rien de net, ou l'image est deja cadree sur l'etiquette
        return img
    k, m = w / small.shape[1], margin
    x0, y0 = max(int((x - m) * k), 0), max(int((y - m) * k), 0)
    return img[y0:min(int((y + bh + m) * k), h), x0:min(int((x + bw + m) * k), w)]


def _deskew(gray: np.ndarray) -> float:
    """Angle (degres) de rotation a appliquer pour redresser le texte."""
    bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    coords = cv2.findNonZero(bw)
    if coords is None:
        return 0.0
    angle = cv2.minAreaRect(coords)[-1]
    angle = angle - 90 if angle > 45 else angle
    return angle if abs(angle) < 15 else 0.0


def normalize_received(img: np.ndarray, target_long_side: int) -> np.ndarray:
    """Redresse legerement et met a l'echelle (cote long = celui du modele)."""
    img = crop_to_label(img)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    angle = _deskew(gray)
    if abs(angle) > 0.3:
        h, w = img.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        img = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))
    scale = target_long_side / max(img.shape[:2])
    if abs(scale - 1) > 0.05:
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=interp)
    return img
