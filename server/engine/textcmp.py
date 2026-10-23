"""OCR, normalisation et comparaison textuelle."""
import re
import unicodedata
from difflib import SequenceMatcher

import cv2
import numpy as np
import pytesseract

from .. import config

# Mentions dont l'alteration est toujours critique (CLP/SGH).
_CRITICAL = re.compile(r"\b(?:H\d{3}[A-Za-z]*|P\d{3}|EUH\d{3}|DANGER|ATTENTION|UN\s?\d{4}|CAS|\d+[.,]?\d*\s?(?:%|ml|l|g|kg|mg))\b", re.I)


def ocr_words(img: np.ndarray, langs: str | None = None, min_conf: int = 60) -> list[dict]:
    """Mots fiables avec leur boite (x, y, w, h) ; l'image est supposee deja a l'echelle de travail."""
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
            conflicting = any(any(ch.isdigit() for ch in c["text"]) and r < 1.0 for c, r in zip(cands, ratios))
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
