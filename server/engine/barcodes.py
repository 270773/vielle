"""Lecture et comparaison des codes-barres / QR codes."""
import cv2
import numpy as np
try:
    from pyzbar import pyzbar
except (ImportError, OSError):  # ZBar/VC++ absents (cas frequent sous Windows) : repli sur OpenCV
    pyzbar = None


def _decode(gray: np.ndarray) -> list[tuple[str, str, tuple[int, int, int, int]]]:
    """[(type, valeur, (x, y, w, h))] avec ZBar si present, sinon avec les detecteurs OpenCV."""
    if pyzbar is not None:
        try:
            return [(c.type, c.data.decode("utf-8", "replace"), (c.rect.left, c.rect.top, c.rect.width, c.rect.height))
                    for c in pyzbar.decode(gray)]
        except OSError:
            pass
    out = []
    try:
        ok, infos, types, pts = cv2.barcode.BarcodeDetector().detectAndDecodeWithType(gray)
        for v, t, p in zip(infos or [], types or [], pts if ok else []):
            if v:
                x, y = p[:, 0].min(), p[:, 1].min()
                out.append((str(t).replace("EAN_13", "EAN13").replace("EAN-13", "EAN13").replace("-", ""), v,
                            (int(x), int(y), int(p[:, 0].max() - x), int(p[:, 1].max() - y))))
    except (cv2.error, AttributeError):
        pass
    try:
        v, p, _ = cv2.QRCodeDetector().detectAndDecode(gray)
        if v and p is not None:
            x, y = p[0][:, 0].min(), p[0][:, 1].min()
            out.append(("QRCODE", v, (int(x), int(y), int(p[0][:, 0].max() - x), int(p[0][:, 1].max() - y))))
    except cv2.error:
        pass
    return out


def read(img: np.ndarray) -> list[tuple[str, str]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    found = set()
    for variant in (gray, cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]):
        found |= {(t, v) for t, v, _ in _decode(variant)}
    return sorted(found)


def locate(img: np.ndarray, margin: int = 8) -> list[tuple[int, int, int, int]]:
    """Boites (x, y, w, h) des codes-barres/QR : leur valeur est verifiee a part, pas par comparaison d'image."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return [(max(x - margin, 0), max(y - margin, 0), w + 2 * margin, h + 2 * margin) for _, _, (x, y, w, h) in _decode(gray)]


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
