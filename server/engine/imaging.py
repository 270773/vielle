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
        return render_pdf(path, dpi)
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
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Image illisible (formats acceptes : PNG, JPEG, TIFF, BMP)")
    return img


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
