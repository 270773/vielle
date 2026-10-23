"""Lecture et comparaison des codes-barres / QR codes."""
import cv2
import numpy as np
from pyzbar import pyzbar


def read(img: np.ndarray) -> list[tuple[str, str]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    found = set()
    for variant in (gray, cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]):
        for c in pyzbar.decode(variant):
            found.add((c.type, c.data.decode("utf-8", "replace")))
    return sorted(found)


def compare(model_img: np.ndarray, recv_img: np.ndarray, *extra: np.ndarray, expected=None) -> tuple[list[dict], dict]:
    # `extra` : images supplementaires (photo originale, pleine resolution) pour fiabiliser la lecture
    exp = read(model_img) if expected is None else expected
    got = set(read(recv_img))
    if not set(exp) <= got:  # lecture plus couteuse (photo d'origine, pleine resolution) seulement si necessaire
        for img in extra:
            got |= set(read(img))
    got = sorted(got)
    ecarts = []
    for t, v in exp:
        if (t, v) not in got:
            same_type = [g for gt, g in got if gt == t]
            ecarts.append({"zone": "code_barres", "type_ecart": "code_different" if same_type else "code_absent",
                           "criticite": 3, "valeur_attendue": f"{t}:{v}",
                           "valeur_trouvee": f"{t}:{same_type[0]}" if same_type else ""})
    for t, v in got:
        if (t, v) not in exp:
            if not any(e["valeur_trouvee"] == f"{t}:{v}" for e in ecarts):
                ecarts.append({"zone": "code_barres", "type_ecart": "code_en_trop", "criticite": 2,
                               "valeur_attendue": "", "valeur_trouvee": f"{t}:{v}"})
    return ecarts, {"modele": [f"{t}:{v}" for t, v in exp], "recu": [f"{t}:{v}" for t, v in got]}
