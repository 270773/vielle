"""OCR, normalisation et comparaison textuelle."""
import re
import unicodedata
from difflib import SequenceMatcher

import cv2
import numpy as np

from .. import config

# Mentions dont l'alteration est toujours critique (CLP/SGH).
_CRITICAL = re.compile(r"\b(?:H\d{3}[A-Za-z]*|P\d{3}|EUH\d{3}|DANGER|ATTENTION|UN\s?\d{4}|CAS|\d+[.,]?\d*\s?(?:%|ml|l|g|kg|mg))\b", re.I)


# Code ISO 639-1 -> pack Tesseract (les langues d'un meme alphabet partagent souvent un pack).
ISO_TO_TESS = {"fr": "fra", "en": "eng", "de": "deu", "es": "spa", "it": "ita", "pt": "por", "nl": "nld", "pl": "pol",
               "tr": "tur", "ru": "rus", "uk": "ukr", "el": "ell", "ar": "ara", "fa": "fas", "he": "heb", "hi": "hin",
               "th": "tha", "vi": "vie", "id": "ind", "ms": "msa", "ja": "jpn", "ko": "kor", "zh": "chi_sim",
               "zh-tw": "chi_tra", "cs": "ces", "sv": "swe", "da": "dan", "no": "nor", "fi": "fin", "ro": "ron",
               "hu": "hun", "bg": "bul"}


def installed_langs() -> list[str]:
    import pytesseract
    return sorted(l for l in pytesseract.get_languages(config="") if l != "osd")


def ocr_langs_for(codes: str) -> str:
    """'tr,en' -> 'tur+eng'. Les packs non installes sont ignores (et signales par l'API /api/langues)."""
    have = set(installed_langs())
    out = []
    for c in (x.strip().lower() for x in codes.replace("+", ",").split(",") if x.strip()):
        t = ISO_TO_TESS.get(c, c)
        if t in have and t not in out:
            out.append(t)
    return "+".join(out) or config.OCR_LANGS


def text_regions(img: np.ndarray) -> list[dict]:
    """Localise les mots/groupes de glyphes sans OCR (valable pour toute langue et toute ecriture)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (11, 3)))
    cnts, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if h < 10 or w < 10 or h > 150 or w > 700:  # bruit, ou grande zone (photo) traitee par la comparaison de formes
            continue
        # Fond non uniforme (photo) : la verification est confiee aux comparaisons de formes et de couleurs.
        bg = gray[y:y + h, x:x + w][ink[y:y + h, x:x + w] == 0]
        if bg.size and float(np.percentile(bg, 75) - np.percentile(bg, 25)) > 20:
            continue
        out.append({"text": "", "conf": 100.0, "box": (x, y, w, h)})
    return out


def _region_scores(mg, rg, box, tol: int = 3, margin: int = 10) -> tuple[float, float]:
    """(part d'encre differente, correlation) d'une zone de texte entre le modele et l'etiquette."""
    x, y, w, h = box
    H, W = mg.shape
    sl = (slice(max(y - 3, 0), min(y + h + 3, H)), slice(max(x - 3, 0), min(x + w + 3, W)))
    ink = [cv2.adaptiveThreshold(g[sl], 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 12) for g in (mg, rg)]
    k = np.ones((2 * tol + 1, 2 * tol + 1), np.uint8)
    diff = cv2.bitwise_or(cv2.bitwise_and(ink[0], cv2.bitwise_not(cv2.dilate(ink[1], k))),
                          cv2.bitwise_and(ink[1], cv2.bitwise_not(cv2.dilate(ink[0], k))))
    diff = cv2.morphologyEx(diff, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    ratio = float(diff.sum()) / max(float(ink[0].sum()), 1.0)
    x0, y0, x1, y1 = max(x - 2, 0), max(y - 2, 0), min(x + w + 2, W), min(y + h + 2, H)
    tpl = mg[y0:y1, x0:x1]
    zone = rg[max(y0 - margin, 0):min(y1 + margin, H), max(x0 - margin, 0):min(x1 + margin, W)]
    if tpl.size == 0 or tpl.std() < 3 or zone.shape[0] < tpl.shape[0] or zone.shape[1] < tpl.shape[1]:
        return ratio, 1.0
    return ratio, float(cv2.matchTemplate(zone, tpl, cv2.TM_CCOEFF_NORMED).max())


def compare_regions(model_regions, model_img, recv_img, k: float = 6.0) -> tuple[list[dict], float]:
    """Verification sans OCR : chaque zone de texte du modele doit se retrouver a l'identique dans l'etiquette.

    Une impression/un scan reels different toujours un peu du PDF (graisse, definition). Le seuil est donc
    relatif : on mesure l'ecart habituel de CE scan sur l'ensemble des zones et on ne signale que les
    zones qui s'en detachent nettement (mot modifie, absent, mal imprime)."""
    if not model_regions:
        return [], 1.0
    mg, rg = (cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY)) for i in (model_img, recv_img))
    sc = np.array([_region_scores(mg, rg, r["box"]) for r in model_regions])
    ratio, ncc = sc[:, 0], sc[:, 1]
    mad = lambda v: 1.4826 * float(np.median(np.abs(v - np.median(v))))
    r_thr = max(0.05, float(np.median(ratio)) + k * mad(ratio))
    n_thr = min(0.8, float(np.median(ncc)) - k * mad(ncc))
    bad = (ratio > r_thr) | (ncc < n_thr)
    ecarts = [{"zone": "{},{},{},{}".format(*r["box"]), "type_ecart": "zone_texte_differente", "criticite": 2,
               "valeur_attendue": "", "valeur_trouvee": ""} for r, b in zip(model_regions, bad) if b]
    return ecarts, 1 - len(ecarts) / len(model_regions)


def ocr_words(img: np.ndarray, langs: str | None = None, min_conf: int = 60) -> list[dict]:
    """Mots fiables avec leur boite (x, y, w, h) ; l'image est supposee deja a l'echelle de travail."""
    import pytesseract
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    d = pytesseract.image_to_data(gray, lang=langs or config.OCR_LANGS, config="--psm 11",
                                  output_type=pytesseract.Output.DICT)
    return [{"text": d["text"][i], "conf": float(d["conf"][i]),
             "box": (d["left"][i], d["top"][i], d["width"][i], d["height"][i])}
            for i in range(len(d["text"]))
            if float(d["conf"][i]) >= min_conf and len(re.findall(r"\w", d["text"][i])) >= 2]


def words_to_text(words: list[dict]) -> str:
    """Texte en ordre de lecture (lignes par bandes horizontales, puis gauche -> droite)."""
    ws = sorted((w["box"][1] + w["box"][3] / 2, w["box"][3], w["box"][0], w["text"]) for w in words)
    lines: list[list] = []
    for cy, h, x, t in ws:
        if lines and abs(cy - lines[-1][0]) <= 0.6 * h:
            lines[-1][1].append((x, t))
            lines[-1][0] = (lines[-1][0] + cy) / 2
        else:
            lines.append([cy, [(x, t)]])
    return "\n".join(" ".join(t for _, t in sorted(l[1])) for l in lines)


def ocr(img: np.ndarray, langs: str | None = None) -> str:
    return words_to_text(ocr_words(img, langs))


def _fold(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.replace("ı", "i").replace("İ", "I"))
    return "".join(c for c in t if not unicodedata.combining(c)).casefold().strip(".,;:()")


def _iou(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(x1 - x0, 0) * max(y1 - y0, 0)
    return inter / (a[2] * a[3] + b[2] * b[3] - inter or 1)


def _present(model_gray: np.ndarray, recv_gray: np.ndarray, box, margin: int = 10, thresh: float = 0.55) -> bool:
    """Le mot du modele est-il visuellement present (a +-margin px) dans l'image recue ?"""
    x, y, w, h = box
    H, W = model_gray.shape
    x0, y0, x1, y1 = max(x - 2, 0), max(y - 2, 0), min(x + w + 2, W), min(y + h + 2, H)
    tpl = model_gray[y0:y1, x0:x1]
    if tpl.size == 0 or tpl.std() < 3:
        return True  # zone uniforme : rien a comparer
    sx0, sy0, sx1, sy1 = max(x0 - margin, 0), max(y0 - margin, 0), min(x1 + margin, W), min(y1 + margin, H)
    zone = recv_gray[sy0:sy1, sx0:sx1]
    if zone.shape[0] < tpl.shape[0] or zone.shape[1] < tpl.shape[1]:
        return False
    return float(cv2.matchTemplate(zone, tpl, cv2.TM_CCOEFF_NORMED).max()) >= thresh


def compare_words(model_words, recv_words, model_img, recv_img) -> tuple[list[dict], float]:
    """Compare les mots du modele a l'etiquette recue.

    Un mot du modele est valide si son image se retrouve (gabarit) ou si l'OCR de l'etiquette
    donne le meme mot au meme endroit ; sinon c'est un ecart. Les mots lus avec une grande
    confiance sur l'etiquette et absents du modele sont signales comme texte en trop.
    """
    mg, rg = (cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY)) for i in (model_img, recv_img))
    ecarts, ok = [], 0

    def near(box, pool, rad):
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        return [w for w in pool if abs(w["box"][0] + w["box"][2] / 2 - cx) < rad + box[2] / 2
                and abs(w["box"][1] + w["box"][3] / 2 - cy) < rad]

    model_words = [w for w in model_words if w["box"][3] >= 12]  # micro-mots = bruit de photo de fond
    for w in model_words:
        cands = near(w["box"], recv_words, 40)
        has_digit = any(ch.isdigit() for ch in w["text"])
        ratios = [SequenceMatcher(None, _fold(w["text"]), _fold(c["text"])).ratio() for c in cands]
        if has_digit:
            # Un chiffre different tient a un pixel : l'accord de l'OCR est exige ; sans lecture OCR
            # exploitable de l'etiquette, la correlation d'image doit etre tres elevee.
            conflicting = any(any(ch.isdigit() for ch in c["text"]) and r < 1.0 and _iou(c["box"], w["box"]) >= 0.5
                              for c, r in zip(cands, ratios))  # meme emplacement, autre valeur
            ok_word = (1.0 in ratios) or (not conflicting and _present(mg, rg, w["box"], thresh=0.8))
        else:
            ok_word = any(r >= 0.85 for r in ratios) or _present(mg, rg, w["box"], thresh=0.7)
        if ok_word:
            ok += 1
            continue
        got = " ".join(c["text"] for c in sorted(cands, key=lambda c: c["box"][0]))
        kind = "texte_different" if got else "texte_manquant"
        crit = 3 if _is_critical(w["text"], got) else 2
        ecarts.append({"zone": "{},{},{},{}".format(*w["box"]), "type_ecart": kind, "criticite": crit,
                       "valeur_attendue": w["text"], "valeur_trouvee": got})
    for c in recv_words:
        if c["conf"] < 85 or len(re.findall(r"[^\W\d_]|\d", c["text"])) < 3 or near(c["box"], model_words, 25) \
                or _present(rg, mg, c["box"]):  # meme mot visible au meme endroit du modele (rate par l'OCR du modele)
            continue
        ecarts.append({"zone": "{},{},{},{}".format(*c["box"]), "type_ecart": "texte_en_trop",
                       "criticite": 3 if _is_critical(c["text"]) else 2, "valeur_attendue": "", "valeur_trouvee": c["text"]})
    return ecarts, ok / len(model_words) if model_words else 1.0


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("’", "'").replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip()


def _tokens(text: str) -> list[str]:
    # Les tokens purement typographiques ("|", "-", ...) sont du bruit d'OCR ou de mise en page.
    return [t for t in normalize(text).split(" ") if re.search(r"\w", t)]


def _is_critical(*chunks: str) -> bool:
    s = " ".join(chunks)
    return bool(_CRITICAL.search(s)) or any(c.isdigit() for c in s)


def compare(expected: str, found: str) -> tuple[list[dict], float]:
    """Retourne (ecarts, similarite 0..1) en comparant mot a mot."""
    a, b = _tokens(expected), _tokens(found)
    sm = SequenceMatcher(None, [t.casefold() for t in a], [t.casefold() for t in b], autojunk=False)
    ecarts = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        exp, got = " ".join(a[i1:i2]), " ".join(b[j1:j2])
        if op == "delete":
            kind = "texte_manquant"
        elif op == "insert":
            kind = "texte_en_trop"
        else:
            kind = "texte_different"
        crit = 3 if _is_critical(exp, got) else 2
        # Differences minimes = probable bruit OCR : a revoir, non bloquant.
        if op == "replace" and SequenceMatcher(None, exp.casefold(), got.casefold()).ratio() >= 0.8 and crit == 2:
            crit = 1
        ecarts.append({"zone": "texte", "type_ecart": kind, "criticite": crit,
                       "valeur_attendue": exp, "valeur_trouvee": got})
    return ecarts, sm.ratio()


def translate(text: str, source: str, target: str) -> str:
    """Traduction via LibreTranslate local ; renvoie le texte inchange si indisponible."""
    if not config.LIBRETRANSLATE_URL or source == target:
        return text
    import httpx
    try:
        r = httpx.post(f"{config.LIBRETRANSLATE_URL}/translate", timeout=30,
                       json={"q": text, "source": source, "target": target, "format": "text"})
        r.raise_for_status()
        return r.json()["translatedText"]
    except Exception:
        return text
