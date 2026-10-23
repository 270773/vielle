"""Alignement et comparaison visuelle (SSIM) entre modele et etiquette recue."""
import cv2
import numpy as np
from skimage.metrics import structural_similarity


def align(recv: np.ndarray, model: np.ndarray) -> tuple[np.ndarray, bool]:
    """Recale `recv` sur `model` (ORB + homographie). Repli : redimensionnement."""
    h, w = model.shape[:2]
    g1, g2 = (cv2.cvtColor(i, cv2.COLOR_BGR2GRAY) for i in (recv, model))
    orb = cv2.ORB_create(4000)
    k1, d1 = orb.detectAndCompute(g1, None)
    k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is not None and d2 is not None and len(k1) > 20 and len(k2) > 20:
        matches = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2), key=lambda m: m.distance)[:500]
        if len(matches) >= 20:
            src = np.float32([k1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
            dst = np.float32([k2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
            H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
            if H is not None and mask.sum() >= 15:
                return cv2.warpPerspective(recv, H, (w, h), borderValue=(255, 255, 255)), True
    return cv2.resize(recv, (w, h), interpolation=cv2.INTER_AREA), False


def match_colors(recv: np.ndarray, model: np.ndarray) -> np.ndarray:
    """Compense l'eclairage : ramene moyenne/ecart-type LAB de la photo sur ceux du modele."""
    a, b = (cv2.cvtColor(i, cv2.COLOR_BGR2LAB).astype(np.float32) for i in (recv, model))
    for ch in range(3):
        sa, sb = a[..., ch].std() or 1, b[..., ch].std()
        a[..., ch] = (a[..., ch] - a[..., ch].mean()) * (sb / sa) + b[..., ch].mean()
    return cv2.cvtColor(np.clip(a, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def diff(model: np.ndarray, recv_aligned: np.ndarray, min_area_ratio: float = 0.0004, tol: int = 8):
    """Retourne (ecarts, score SSIM, image annotee)."""
    g1, g2 = (cv2.cvtColor(i, cv2.COLOR_BGR2GRAY) for i in (model, recv_aligned))
    score = float(structural_similarity(cv2.GaussianBlur(g1, (5, 5), 0), cv2.GaussianBlur(g2, (5, 5), 0)))
    # Comparaison tolerante au leger decalage : un pixel encre n'est un ecart que s'il n'a
    # aucun voisin encre dans l'autre image.
    b1, b2 = (cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15) for g in (g1, g2))
    k = np.ones((tol * 2 + 1, tol * 2 + 1), np.uint8)
    mask = cv2.bitwise_or(cv2.bitwise_and(b1, cv2.bitwise_not(cv2.dilate(b2, k))),
                          cv2.bitwise_and(b2, cv2.bitwise_not(cv2.dilate(b1, k))))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    total = mask.shape[0] * mask.shape[1]
    out = recv_aligned.copy()
    ecarts = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        ratio = w * h / total
        if ratio < min_area_ratio:
            continue
        H, W = mask.shape
        edge = x < 20 or y < 20 or x + w > W - 20 or y + h > H - 20
        if (edge and min(w, h) < 60) or (max(w, h) > 6 * min(w, h) and min(w, h) < 20):
            continue  # liseres de bord de feuille / traits fins : artefacts de prise de vue
        crit = 3 if ratio > 0.03 else 2 if ratio > 0.008 else 1
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 0, 255), 4)
        ecarts.append({"zone": f"{x},{y},{w},{h}", "type_ecart": "ecart_visuel", "criticite": crit,
                       "valeur_attendue": "conforme au modele",
                       "valeur_trouvee": f"difference visuelle ({ratio * 100:.1f} % de la surface)"})
    return ecarts, score, out
