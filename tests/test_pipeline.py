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
