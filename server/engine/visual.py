"""Alignement et comparaison visuelle (SSIM) entre modele et etiquette recue."""
import cv2
import numpy as np
from skimage.metrics import structural_similarity


def model_features(model: np.ndarray):
    """Points ORB du modele (calcules une fois par modele)."""
    return cv2.ORB_create(4000).detectAndCompute(cv2.cvtColor(model, cv2.COLOR_BGR2GRAY), None)


def align(recv: np.ndarray, model: np.ndarray, features=None) -> tuple[np.ndarray, bool, np.ndarray]:
    """Recale `recv` sur `model` (ORB + homographie). Repli : redimensionnement.

    Retourne aussi le masque des pixels du modele effectivement couverts par l'image recue
    (un scan partiel laisse une partie de l'etiquette hors image)."""
    h, w = model.shape[:2]
    k1, d1 = cv2.ORB_create(4000).detectAndCompute(cv2.cvtColor(recv, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = features or model_features(model)
    if d1 is not None and d2 is not None and len(k1) > 20 and len(k2) > 20:
        matches = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2), key=lambda m: m.distance)[:500]
        if len(matches) >= 20:
            src = np.float32([k1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
            dst = np.float32([k2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
            H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
            if H is not None and mask.sum() >= 15:
                warped = cv2.warpPerspective(recv, H, (w, h), borderValue=(255, 255, 255))
                cover = cv2.warpPerspective(np.full(recv.shape[:2], 255, np.uint8), H, (w, h))
                out, cover = _refine(warped, model, cover)
                return out, True, cover
    return cv2.resize(recv, (w, h), interpolation=cv2.INTER_AREA), False, np.full((h, w), 255, np.uint8)


def _refine(warped: np.ndarray, model: np.ndarray, cover: np.ndarray):
    """Affine le recalage au pixel pres (ECC, transformation affine) ; ignore si la correlation ne progresse pas."""
    try:
        k = 0.35
        gray = lambda i: cv2.GaussianBlur(cv2.resize(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY), None, fx=k, fy=k), (5, 5), 0)
        a, b = gray(warped), gray(model)
        m = np.eye(2, 3, dtype=np.float32)
        cc, m = cv2.findTransformECC(b, a, m, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-4), None, 5)
        before = cv2.matchTemplate(a, b, cv2.TM_CCOEFF_NORMED)[0, 0]
        if cc < 0.5 or cc <= before + 0.002:
            return warped, cover
        S = np.diag([k, k, 1]).astype(np.float32)
        full = (np.linalg.inv(S) @ np.vstack([m, [0, 0, 1]]).astype(np.float32) @ S)[:2]
        size, fl = (model.shape[1], model.shape[0]), cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP
        return (cv2.warpAffine(warped, full, size, flags=fl, borderValue=(255, 255, 255)),
                cv2.warpAffine(cover, full, size, flags=fl))
    except cv2.error:
        return warped, cover


def match_colors(recv: np.ndarray, model: np.ndarray, cover: np.ndarray | None = None) -> tuple[np.ndarray, float]:
    """Etalonnage couleur robuste : ajuste une transformation lineaire BGR (matrice 3x3 + decalage) entre le scan et
    le modele, en ignorant les zones qui different localement (moindres carres iteres). Elle absorbe la derive
    globale de l'impression et du scanner, mais pas un changement local (logo, bandeau...).

    Retourne l'image corrigee et l'amplitude de la correction (0 = aucune), pour signaler une teinte globale anormale."""
    h, w = model.shape[:2]
    step = max(h, w) // 400 or 1
    X = recv[::step, ::step].reshape(-1, 3).astype(np.float64)
    Y = model[::step, ::step].reshape(-1, 3).astype(np.float64)
    if cover is not None:
        ok = (cover[::step, ::step].reshape(-1) > 127)
        X, Y = X[ok], Y[ok]
    if len(X) < 500:
        return recv, 0.0
    X1 = np.hstack([X, np.ones((len(X), 1))])
    prior = np.vstack([np.eye(3), np.zeros((1, 3))])  # regularisation vers l'identite (etiquettes presque monochromes)
    lam = 300.0 * len(X) / 1000
    reg = lam * np.diag([1, 1, 1, 0.01])
    wgt = np.ones(len(X))
    M = prior
    for _ in range(7):
        A = X1.T @ (X1 * wgt[:, None]) + reg
        M = np.linalg.solve(A, X1.T @ (Y * wgt[:, None]) + reg @ prior)
        wgt = 1.0 / (1.0 + (np.linalg.norm(X1 @ M - Y, axis=1) / 8.0) ** 2)
    out = cv2.transform(recv, M.T.astype(np.float32))  # matrice 3x4 : canaux + decalage, sature en uint8
    shift = float(np.abs(out.astype(np.int16)[::step, ::step] - recv.astype(np.int16)[::step, ::step]).mean() / 255)
    return out, shift


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
        small = cv2.resize(img, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        x = cv2.cvtColor(cv2.GaussianBlur(small, (0, 0), 5), cv2.COLOR_BGR2LAB).astype(np.float32)
        return x * [100 / 255, 1, 1] - [0, 128, 128]
    de = cv2.resize(np.linalg.norm(lab(model) - lab(recv_aligned), axis=2), (model.shape[1], model.shape[0]),
                    interpolation=cv2.INTER_LINEAR)
    mask = (de > threshold).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    _clear_border(mask)
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


def match_sharpness(model: np.ndarray, recv: np.ndarray) -> np.ndarray:
    """Floute le modele jusqu'a la nettete du scan (resolution de scan plus basse, impression) pour que
    la comparaison ne signale pas la simple difference de definition."""
    lap = lambda im: cv2.Laplacian(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
    target = lap(recv)
    best, best_err = model, abs(lap(model) - target)
    for sigma in (0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 4.0):
        cand = cv2.GaussianBlur(model, (0, 0), sigma)
        err = abs(lap(cand) - target)
        if err < best_err:
            best, best_err = cand, err
    return best


def _clear_border(mask: np.ndarray, frac: float = 0.015) -> None:
    """Le bord du scan (rognage, ombre, defaut de recalage) ne porte pas d'information fiable."""
    b = int(max(mask.shape) * frac)
    mask[:b, :] = 0; mask[-b:, :] = 0; mask[:, :b] = 0; mask[:, -b:] = 0


def diff(model: np.ndarray, recv_aligned: np.ndarray, min_area_ratio: float = 0.0004, tol: int = 8):
    """Retourne (ecarts, score SSIM, image annotee)."""
    g1, g2 = (cv2.cvtColor(i, cv2.COLOR_BGR2GRAY) for i in (model, recv_aligned))
    half = lambda g: cv2.GaussianBlur(cv2.resize(g, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA), (5, 5), 0)
    score = float(structural_similarity(half(g1), half(g2)))
    # Comparaison tolerante au leger decalage : un pixel encre n'est un ecart que s'il n'a
    # aucun voisin encre dans l'autre image.
    b1, b2 = (cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15) for g in (g1, g2))
    k = np.ones((tol * 2 + 1, tol * 2 + 1), np.uint8)
    mask = cv2.bitwise_or(cv2.bitwise_and(b1, cv2.bitwise_not(cv2.dilate(b2, k))),
                          cv2.bitwise_and(b2, cv2.bitwise_not(cv2.dilate(b1, k))))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    _clear_border(mask)
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
