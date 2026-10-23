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


def ocr(img: np.ndarray, langs: str | None = None) -> str:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, h=10)
    return pytesseract.image_to_string(gray, lang=langs or config.OCR_LANGS, config="--psm 6")


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
