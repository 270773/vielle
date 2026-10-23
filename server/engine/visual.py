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
                return _refine(cv2.warpPerspective(recv, H, (w, h), borderValue=(255, 255, 255)), model), True
    return cv2.resize(recv, (w, h), interpolation=cv2.INTER_AREA), False


def _refine(warped: np.ndarray, model: np.ndarray) -> np.ndarray:
    """Affine le recalage au pixel pres (ECC) : indispensable pour comparer finement un scan."""
    try:
        k = 0.5
        a, b = (cv2.GaussianBlur(cv2.resize(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY), None, fx=k, fy=k), (5, 5), 0)
                for i in (warped, model))
        m = np.eye(3, dtype=np.float32)
        cc, m = cv2.findTransformECC(b, a, m, cv2.MOTION_HOMOGRAPHY, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), None, 5)
        if cc < 0.5:
            return warped
        S = np.diag([k, k, 1]).astype(np.float32)
        full = np.linalg.inv(S) @ m @ S
        return cv2.warpPerspective(warped, full, (model.shape[1], model.shape[0]),
                                   flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderValue=(255, 255, 255))
    except cv2.error:
        return warped


def match_colors(recv: np.ndarray, model: np.ndarray) -> np.ndarray:
    """Etalonnage par le blanc : le papier blanc du modele sert de reference, un gain par canal
    compense l'eclairage / le scanner sans masquer un changement de couleur de l'etiquette."""
    white = (model > 235).all(axis=2)
    if white.mean() < 0.01:
        return recv
    gain = model[white].mean(axis=0) / np.maximum(recv[white].mean(axis=0), 1)
    return np.clip(recv.astype(np.float32) * gain, 0, 255).astype(np.uint8)


_NAMES = [("noir", 0, 0, 12), ("blanc", 0, 0, 90), ("gris", 0, 0, 0)]


def color_name(bgr) -> str:
    h, s, v = cv2.cvtColor(np.uint8([[bgr]]), cv2.COLOR_BGR2HSV)[0, 0]
    if v < 50:
        return "noir"
    if s < 40:
        return "blanc" if v > 200 else "gris"
    hue = int(h) * 2
    for hi, n in ((15, "rouge"), (40, "orange"), (65, "jaune"), (170, "vert"), (200, "cyan"), (260, "bleu"),
                  (300, "violet"), (345, "rose"), (361, "rouge")):
        if hue < hi:
            return n if not (n == "orange" and v < 150) else "marron"
    return "rouge"


def color_diff(model: np.ndarray, recv_aligned: np.ndarray, out: np.ndarray, threshold: float = 14.0,
               min_area_ratio: float = 0.0006):
    """Ecarts de couleur : deltaE (CIELAB) entre les deux images lissees, par zones."""
    def lab(img):
        x = cv2.cvtColor(cv2.GaussianBlur(img, (0, 0), 10), cv2.COLOR_BGR2LAB).astype(np.float32)
        return x * [100 / 255, 1, 1] - [0, 128, 128]
    de = np.linalg.norm(lab(model) - lab(recv_aligned), axis=2)
    mask = (de > threshold).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    H, W = mask.shape
    ecarts = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        edge = x < 30 or y < 30 or x + w > W - 30 or y + h > H - 30
        if w * h / (H * W) < min_area_ratio or (edge and min(w, h) < 80):  # liseres de bord = artefact de scan
            continue
        zone = np.zeros_like(mask); cv2.drawContours(zone, [c], -1, 255, -1)
        mean_e = float(de[zone > 0].mean())
        exp = model[zone > 0].mean(axis=0).astype(np.uint8)
        got = recv_aligned[zone > 0].mean(axis=0).astype(np.uint8)
        crit = 3 if mean_e > 28 else 2 if mean_e > 18 else 1
        cv2.rectangle(out, (x, y), (x + w, y + h), (255, 0, 255), 4)
        hexc = lambda v: "#%02x%02x%02x" % (v[2], v[1], v[0])
        ecarts.append({"zone": f"{x},{y},{w},{h}", "type_ecart": "ecart_couleur", "criticite": crit,
                       "valeur_attendue": f"{color_name(exp)} {hexc(exp)}", "valeur_trouvee": f"{color_name(got)} {hexc(got)} (dE={mean_e:.0f})"})
    return ecarts


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
        ecarts.append({"zone": f"{x},{y},{w},{h}", "type_ecart": "ecart_forme", "criticite": crit,
                       "valeur_attendue": "identique au modele",
                       "valeur_trouvee": f"texte, symbole ou logo different ({ratio * 100:.1f} % de la surface)"})
    return ecarts, score, out
