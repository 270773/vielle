"""API LabelQC (FastAPI)."""
import hashlib
from pathlib import Path

import cv2
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, report
from .engine import imaging, pipeline

app = FastAPI(title="LabelQC")
STATIC = Path(__file__).parent / "static"


@app.on_event("startup")
def startup() -> None:
    config.PDF_ROOT.mkdir(parents=True, exist_ok=True)
    config.ARCHIVE_PATH.mkdir(parents=True, exist_ok=True)
    db.init()
    db.sync_models()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/modeles")
def modeles():
    db.sync_models()
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, ref_produit, fournisseur, langue, version, date_validation FROM modeles_pdf "
            "ORDER BY fournisseur, ref_produit, version")]


@app.get("/api/modeles/{mid}/pdf")
def modele_pdf(mid: int):
    with db.conn() as c:
        r = c.execute("SELECT chemin_reseau FROM modeles_pdf WHERE id=?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404, "Modele inconnu")
    return FileResponse(r["chemin_reseau"], media_type="application/pdf")


@app.post("/api/controles")
async def creer_controle(request: Request, modele_id: int = Form(...), langue_etiquette: str = Form(""),
                         image: UploadFile = File(...), x_user: str = Header("anonyme")):
    with db.conn() as c:
        m = c.execute("SELECT * FROM modeles_pdf WHERE id=?", (modele_id,)).fetchone()
    if not m:
        raise HTTPException(404, "Modele inconnu")
    data = await image.read()
    try:
        img = imaging.decode_image(data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res = pipeline.run(Path(m["chemin_reseau"]), img, model_lang=m["langue"], label_lang=langue_etiquette or None)

    with db.conn() as c:
        cur = c.execute("INSERT INTO controles(date_heure,utilisateur_id,modele_id,statut,score_global,detail_json)"
                        " VALUES(?,?,?,?,?,?)", (db.now(), x_user, modele_id, res.statut, res.score_global,
                                                 db.dumps({"codes": res.codes, "scores": res.scores, "aligne": res.aligne,
                                                           "texte_modele": res.texte_modele, "texte_recu": res.texte_recu})))
        cid = cur.lastrowid
        folder = config.ARCHIVE_PATH / f"controle_{cid}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "etiquette_recue.png").write_bytes(cv2.imencode(".png", img)[1].tobytes())
        (folder / "ecarts.jpg").write_bytes(cv2.imencode(".jpg", res.overlay)[1].tobytes())
        c.execute("UPDATE controles SET image_path=?, overlay_path=? WHERE id=?",
                  (str(folder / "etiquette_recue.png"), str(folder / "ecarts.jpg"), cid))
        for e in res.ecarts:
            c.execute("INSERT INTO ecarts(controle_id,zone,type_ecart,criticite,valeur_attendue,valeur_trouvee)"
                      " VALUES(?,?,?,?,?,?)", (cid, e["zone"], e["type_ecart"], e["criticite"],
                                               e["valeur_attendue"], e["valeur_trouvee"]))
        db.audit(c, x_user, "controle", f"id={cid} modele={modele_id} statut={res.statut}",
                 request.client.host if request.client else "")
    return _controle(cid)


def _controle(cid: int) -> dict:
    with db.conn() as c:
        r = c.execute("SELECT * FROM controles WHERE id=?", (cid,)).fetchone()
        if not r:
            raise HTTPException(404, "Controle inconnu")
        ecarts = [dict(e) for e in c.execute("SELECT * FROM ecarts WHERE controle_id=? ORDER BY criticite DESC, id", (cid,))]
        v = c.execute("SELECT * FROM validations WHERE controle_id=? ORDER BY id DESC", (cid,)).fetchone()
    import json
    out = {k: r[k] for k in ("id", "date_heure", "utilisateur_id", "modele_id", "statut", "score_global")}
    out.update(json.loads(r["detail_json"]), ecarts=ecarts, validation=dict(v) if v else None)
    return out


@app.get("/api/controles/{cid}")
def get_controle(cid: int):
    return _controle(cid)


@app.get("/api/controles")
def liste_controles(limit: int = 50):
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,date_heure,utilisateur_id,modele_id,statut,score_global FROM controles ORDER BY id DESC LIMIT ?", (limit,))]


@app.get("/api/controles/{cid}/image")
def image_ecarts(cid: int):
    with db.conn() as c:
        r = c.execute("SELECT overlay_path FROM controles WHERE id=?", (cid,)).fetchone()
    if not r:
        raise HTTPException(404, "Controle inconnu")
    return FileResponse(r["overlay_path"], media_type="image/jpeg")


class Decision(BaseModel):
    decision: str  # ACCEPTE | REFUSE
    commentaire: str = ""


@app.post("/api/controles/{cid}/validation")
def valider(cid: int, d: Decision, request: Request, x_user: str = Header("anonyme")):
    if d.decision not in ("ACCEPTE", "REFUSE"):
        raise HTTPException(400, "decision doit etre ACCEPTE ou REFUSE")
    c0 = _controle(cid)
    if d.decision == "ACCEPTE" and c0["statut"] == "NON_CONFORME" and not d.commentaire.strip():
        raise HTTPException(400, "Un commentaire est obligatoire pour accepter une etiquette non conforme")
    when = db.now()
    with db.conn() as c:
        c.execute("INSERT INTO validations(controle_id,utilisateur_id,date,decision,commentaire,signature_hash)"
                  " VALUES(?,?,?,?,?,?)", (cid, x_user, when, d.decision, d.commentaire, db.sign(cid, x_user, d.decision, when)))
        db.audit(c, x_user, "validation", f"id={cid} {d.decision}", request.client.host if request.client else "")
    return _controle(cid)


@app.get("/api/controles/{cid}/rapport")
def rapport(cid: int, request: Request, x_user: str = Header("anonyme")):
    ctl = _controle(cid)
    with db.conn() as c:
        m = dict(c.execute("SELECT * FROM modeles_pdf WHERE id=?", (ctl["modele_id"],)).fetchone())
        ov = c.execute("SELECT overlay_path FROM controles WHERE id=?", (cid,)).fetchone()["overlay_path"]
    pdf = report.build(ctl, m, ctl["ecarts"], ctl["validation"], Path(ov).read_bytes())
    path = config.ARCHIVE_PATH / f"controle_{cid}" / "rapport.pdf"
    path.write_bytes(pdf)
    with db.conn() as c:
        c.execute("INSERT INTO rapports(controle_id,chemin_pdf,date_generation,hash_sha256) VALUES(?,?,?,?)",
                  (cid, str(path), db.now(), hashlib.sha256(pdf).hexdigest()))
        db.audit(c, x_user, "rapport", f"id={cid}", request.client.host if request.client else "")
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="controle_{cid}.pdf"'})


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
