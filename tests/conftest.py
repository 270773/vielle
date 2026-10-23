import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_tmp = tempfile.mkdtemp()
os.environ.update(LABELQC_DB_PATH=f"{_tmp}/t.db", LABELQC_PDF_ROOT=f"{_tmp}/modeles",
                  LABELQC_ARCHIVE_PATH=f"{_tmp}/archives", LABELQC_OCR_LANGS="fra+eng", LABELQC_ADMIN_PASSWORD="motdepasse-test")


def make_label_pdf(path: Path, h_code: str = "H225", ean: str = "3057640385148", body: str = "Acetone 99,5 %") -> None:
    from reportlab.graphics.barcode import eanbc
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=(100 * mm, 100 * mm))
    c.setFont("Helvetica-Bold", 16); c.drawString(8 * mm, 88 * mm, "DANGER")
    c.setFont("Helvetica", 11)
    c.drawString(8 * mm, 78 * mm, body)
    c.drawString(8 * mm, 70 * mm, f"{h_code} Liquide et vapeurs tres inflammables")
    c.drawString(8 * mm, 62 * mm, "P210 Tenir a l'ecart de la chaleur")
    c.drawString(8 * mm, 54 * mm, "Lot A1234 - Fabricant Dupont SA")
    d = Drawing(60 * mm, 25 * mm)
    d.add(eanbc.Ean13BarcodeWidget(ean, barHeight=18 * mm))
    renderPDF.draw(d, c, 15 * mm, 12 * mm)
    c.showPage(); c.save()


@pytest.fixture(scope="session")
def models():
    root = Path(os.environ["LABELQC_PDF_ROOT"])
    make_label_pdf(root / "Acme" / "REF001" / "1" / "modele.pdf")
    return root


def login(client, user="admin", password="motdepasse-test"):
    r = client.post("/api/login", json={"login": user, "password": password})
    assert r.status_code == 200, r.text
    return r.json()
