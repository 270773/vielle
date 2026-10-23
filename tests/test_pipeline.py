import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import make_label_pdf
from server import config
from server.engine import imaging, pipeline


def scan_of(pdf, tmp_path, rotate=0.0, noise=True):
    img = imaging.render_pdf(pdf, 200)
    img = cv2.resize(img, None, fx=0.8, fy=0.8)
    h, w = img.shape[:2]
    if rotate:
        img = cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2, h / 2), rotate, 1), (w, h), borderValue=(255, 255, 255))
    if noise:
        img = np.clip(img.astype(int) + np.random.default_rng(0).normal(0, 6, img.shape), 0, 255).astype(np.uint8)
    return img


def test_conforme(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    r = pipeline.run(pdf, scan_of(pdf, tmp_path, rotate=1.5))
    assert r.statut in ("CONFORME", "A_REVOIR"), r.ecarts
    assert not [e for e in r.ecarts if e["criticite"] >= 2], r.ecarts
    assert r.codes["recu"] == r.codes["modele"] != []


def test_code_h_modifie(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    bad = tmp_path / "bad.pdf"
    make_label_pdf(bad, h_code="H226")
    r = pipeline.run(pdf, scan_of(bad, tmp_path))
    assert r.statut == "NON_CONFORME"
    assert r.ecarts and max(e["criticite"] for e in r.ecarts) >= 2, r.ecarts  # sans OCR : zone/forme differente


@pytest.mark.skipif(not __import__("shutil").which("tesseract"), reason="Tesseract absent")
def test_code_h_modifie_avec_ocr(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    bad = tmp_path / "bad.pdf"
    make_label_pdf(bad, h_code="H226")
    r = pipeline.run(pdf, scan_of(bad, tmp_path), use_ocr=True)
    assert any(e["criticite"] == 3 and "H22" in (e["valeur_attendue"] + e["valeur_trouvee"]) for e in r.ecarts)


def test_code_barres_different(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    bad = tmp_path / "bad.pdf"
    make_label_pdf(bad, ean="4006381333931")
    r = pipeline.run(pdf, scan_of(bad, tmp_path))
    assert r.statut == "NON_CONFORME"
    assert any(e["zone"] == "code_barres" and e["type_ecart"] == "code_different" for e in r.ecarts)


def test_api_flux_complet(models, tmp_path):
    from server.main import app
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    bad = tmp_path / "bad.pdf"
    make_label_pdf(bad, h_code="H226")
    png = cv2.imencode(".png", scan_of(bad, tmp_path))[1].tobytes()
    with TestClient(app) as c:
        mid = c.get("/api/modeles").json()[0]["id"]
        r = c.post("/api/controles", data={"modele_id": mid}, files={"image": ("e.png", png, "image/png")}, headers={"X-User": "alice"})
        assert r.status_code == 200 and r.json()["statut"] == "NON_CONFORME"
        cid = r.json()["id"]
        assert c.post(f"/api/controles/{cid}/validation", json={"decision": "ACCEPTE"}).status_code == 400
        v = c.post(f"/api/controles/{cid}/validation", json={"decision": "REFUSE", "commentaire": "H226 au lieu de H225"}, headers={"X-User": "alice"})
        assert v.json()["validation"]["signature_hash"]
        assert c.get(f"/api/controles/{cid}/rapport").content.startswith(b"%PDF")
        assert c.get(f"/api/controles/{cid}/image").status_code == 200
        assert c.post("/api/controles", data={"modele_id": mid}, files={"image": ("x.png", b"nope", "image/png")}).status_code == 400


def test_modele_image_et_etiquette_tournee(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    model_png = tmp_path / "modele.png"
    cv2.imwrite(str(model_png), imaging.render_pdf(pdf, 150))
    scan = cv2.rotate(scan_of(pdf, tmp_path), cv2.ROTATE_90_CLOCKWISE)
    r = pipeline.run(model_png, scan)
    assert r.aligne
    assert r.codes["recu"] == r.codes["modele"] != []
    assert not [e for e in r.ecarts if e["criticite"] >= 2], r.ecarts


def _a4_scan(label, tmp_path, dpi_scale=1.0, rot=1.0):
    """Etiquette posee de travers sur une feuille A4 a 200 dpi (fond blanc cote vitre)."""
    canvas = np.full((2339, 1654, 3), 245, np.uint8)
    lab = cv2.resize(label, None, fx=dpi_scale, fy=dpi_scale)
    h, w = lab.shape[:2]
    canvas[300:300 + h, 250:250 + w] = lab
    return cv2.warpAffine(canvas, cv2.getRotationMatrix2D((827, 1170), rot, 1), (1654, 2339), borderValue=(245, 245, 245))


def test_scan_a4_etiquette_au_milieu(models, tmp_path):
    pdf = models / "Acme" / "REF001" / "1" / "modele.pdf"
    scan = _a4_scan(scan_of(pdf, tmp_path), tmp_path)
    r = pipeline.run(pdf, scan)
    assert r.aligne and r.codes["recu"] == r.codes["modele"] != []
    assert not [e for e in r.ecarts if e["criticite"] >= 2], r.ecarts


def test_scan_depose_dans_le_dossier_d_entree(models, tmp_path):
    from server.main import app
    bad = tmp_path / "bad.pdf"
    make_label_pdf(bad, h_code="H226")
    png = cv2.imencode(".png", _a4_scan(scan_of(bad, tmp_path), tmp_path))[1].tobytes()
    (config.SCAN_INBOX).mkdir(parents=True, exist_ok=True)
    (config.SCAN_INBOX / "scan001.png").write_bytes(png)
    (config.SCAN_INBOX / "note.txt").write_text("ignore")
    with TestClient(app) as c:
        assert [s["nom"] for s in c.get("/api/scans").json()] == ["scan001.png"]
        assert c.get("/api/scans/..%2Fconfig.py").status_code == 404
        mid = c.get("/api/modeles").json()[0]["id"]
        r = c.post("/api/controles", data={"modele_id": mid, "scan": "scan001.png"})
        assert r.status_code == 200 and r.json()["statut"] == "NON_CONFORME"
        assert c.get("/api/scans").json() == []


def test_detection_automatique_du_modele(models, tmp_path):
    from server.main import app
    root = models.parent if False else models
    make_label_pdf(root / "Acme" / "ETIQ_ETHANOL_96_E200123_20kg.pdf", h_code="H225", ean="4006381333931", body="Ethanol 96 % vol")
    with TestClient(app) as c:
        by_name = {m["nom_produit"]: m["id"] for m in c.get("/api/modeles").json()}
        assert any("ETHANOL" in n for n in by_name)
        assert [m["code_etiquette"] for m in c.get("/api/modeles", params={"q": "ethanol"}).json()] == ["E200123"]
        scan = cv2.imencode(".png", _a4_scan(scan_of(models / "Acme" / "ETIQ_ETHANOL_96_E200123_20kg.pdf", tmp_path), tmp_path))[1].tobytes()
        r = c.post("/api/identifier", files={"image": ("s.png", scan, "image/png")}).json()
        assert r["sur"] and "ETHANOL" in r["candidats"][0]["nom"] and r["candidats"][0]["ean"]
        r = c.post("/api/controles", files={"image": ("s.png", scan, "image/png")})  # sans modele_id
        assert r.status_code == 200 and r.json()["statut"] in ("CONFORME", "A_REVOIR"), r.text
        assert c.post("/api/controles", files={"image": ("x.png", cv2.imencode(".png", np.full((300, 300, 3), 200, np.uint8))[1].tobytes(), "image/png")}).status_code == 409
