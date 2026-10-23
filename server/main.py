"""API LabelQC (FastAPI)."""
import hashlib
import threading
from pathlib import Path

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response as _R, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, db, identify, report
from .engine import imaging, pipeline, textcmp

app = FastAPI(title="LabelQC")
STATIC = Path(__file__).parent / "static"


def _warm_up() -> None:
    """Calcule a l'avance l'empreinte de chaque modele : le premier controle n'attend plus."""
    try:
        db.sync_models()
        with db.conn() as c:
            paths = [Path(r["chemin_reseau"]) for r in c.execute("SELECT chemin_reseau FROM modeles_pdf")]
        for p in paths:
            identify._model_signature(str(p), p.stat().st_mtime_ns)
            pipeline._model_bundle(str(p), p.stat().st_mtime_ns)
    except Exception as e:  # ne jamais empecher le demarrage
        print(f"[LabelQC] prechauffage incomplet : {e}", flush=True)


@app.on_event("startup")
def startup() -> None:
    config.PDF_ROOT.mkdir(parents=True, exist_ok=True)
    config.ARCHIVE_PATH.mkdir(parents=True, exist_ok=True)
    config.SCAN_INBOX.mkdir(parents=True, exist_ok=True)
    db.init()
    threading.Thread(target=_warm_up, daemon=True).start()  # prepare les modeles pendant que l'utilisateur se connecte
    pwd = auth.ensure_admin()
    if pwd:
        print(f"[LabelQC] Compte initial cree : admin / {pwd}  (a changer : python -m server user add admin <mdp> admin)", flush=True)
    db.sync_models()


class Login(BaseModel):
    login: str
    password: str


@app.post("/api/login")
def login(d: Login, request: Request, response: Response):
    user = auth.verify_login(d.login, d.password)
    with db.conn() as c:
        db.audit(c, d.login, "connexion" if user else "echec_connexion", "", request.client.host if request.client else "")
    if not user:
        raise HTTPException(401, "Identifiant ou mot de passe incorrect")
    response.set_cookie(auth.COOKIE, auth.make_token(user), max_age=auth.SESSION_SECONDS, httponly=True, samesite="strict")
    return user


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/moi")
def moi(user: dict = Depends(auth.current_user)):
    return user


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/modeles")
def modeles(q: str = "", user: dict = Depends(auth.current_user)):
    """Modeles indexes ; `q` filtre sur le nom du produit ou le code d'etiquette."""
    db.sync_models()
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, ref_produit, fournisseur, langue, version, date_validation, nom_produit, code_etiquette "
            "FROM modeles_pdf ORDER BY fournisseur, nom_produit, version")]
    toks = identify._tokens(q)
    return [r for r in rows if all(t in identify._fold(f"{r['nom_produit']} {r['code_etiquette']} {r['ref_produit']} {r['fournisseur']}") for t in toks)]


@app.post("/api/identifier")
async def identifier(image: UploadFile | None = File(None), scan: str = Form(""), q: str = Form(""),
                     user: dict = Depends(auth.current_user)):
    """Propose les modeles correspondant a l'etiquette (code-barres + ressemblance visuelle)."""
    return await run_in_threadpool(identify.identify, await _read_input(image, scan), q)


@app.get("/api/langues")
def langues(user: dict = Depends(auth.current_user)):
    """Packs de langues OCR installes sur le serveur."""
    return textcmp.installed_langs()


@app.get("/api/modeles/{mid}/pdf")
def modele_pdf(mid: int, user: dict = Depends(auth.current_user)):
    with db.conn() as c:
        r = c.execute("SELECT chemin_reseau FROM modeles_pdf WHERE id=?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404, "Modele inconnu")
    return FileResponse(r["chemin_reseau"])


MAX_UPLOAD = 80 * 1024 * 1024
SCAN_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".pdf"}


@app.get("/api/scans")
def scans_entrants(user: dict = Depends(auth.current_user)):
    """Scans deposes par le scanner dans le dossier d'entree, du plus recent au plus ancien."""
    files = [f for f in config.SCAN_INBOX.iterdir() if f.is_file() and f.suffix.lower() in SCAN_EXT]
    return [{"nom": f.name, "taille": f.stat().st_size, "date": f.stat().st_mtime}
            for f in sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)]


@app.get("/api/scans/{nom}")
def scan_apercu(nom: str, user: dict = Depends(auth.current_user)):
    f = _scan_path(nom)
    return Response(cv2.imencode(".jpg", _small(imaging.decode_image(f.read_bytes())))[1].tobytes(), media_type="image/jpeg")


async def _read_input(image, scan: str):
    if scan:
        data = _scan_path(scan).read_bytes()
    elif image is not None:
        data = await image.read()
    else:
        raise HTTPException(400, "Fournir un scan du dossier d'entree ou une image")
    try:
        return imaging.decode_image(data)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _small(img, side: int = 900):
    k = side / max(img.shape[:2])
    return cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else img


def _scan_path(nom: str) -> Path:
    f = (config.SCAN_INBOX / nom).resolve()
    if f.parent != config.SCAN_INBOX.resolve() or not f.is_file() or f.suffix.lower() not in SCAN_EXT:
        raise HTTPException(404, "Scan introuvable")
    return f


@app.post("/api/controles")
async def creer_controle(request: Request, modele_id: int | None = Form(None), langue_etiquette: str = Form(""),
                         image: UploadFile | None = File(None), scan: str = Form(""), q: str = Form(""),
                         user: dict = Depends(auth.current_user)):
    """Controle d'une etiquette. Sans `modele_id`, le modele est detecte automatiquement (`q` = nom/code optionnel)."""
    scan_file = _scan_path(scan) if scan else None
    data = scan_file.read_bytes() if scan_file else (await image.read() if image is not None else b"")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Fichier trop volumineux (80 Mo maximum)")
    if not data:
        raise HTTPException(400, "Fournir un scan du dossier d'entree ou une image")
    try:
        img = imaging.decode_image(data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if modele_id is None:
        found = await run_in_threadpool(identify.identify, img, q)
        if not found["sur"]:
            raise HTTPException(409, detail={"message": "Modele non identifie avec certitude : choisir un candidat",
                                             "candidats": found["candidats"]})
        modele_id = found["candidats"][0]["modele_id"]
    with db.conn() as c:
        m = c.execute("SELECT * FROM modeles_pdf WHERE id=?", (modele_id,)).fetchone()
    if not m:
        raise HTTPException(404, "Modele inconnu")
    langs = textcmp.ocr_langs_for(m["langues_ocr"] or m["langue"]) if config.USE_OCR else None
    try:
        res = await run_in_threadpool(pipeline.run, Path(m["chemin_reseau"]), img, langs, m["langue"], langue_etiquette or None)
    except Exception as e:  # modele illisible, image degeneree... : message exploitable plutot qu'une erreur 500 muette
        raise HTTPException(422, f"Analyse impossible : {e}")

    with db.conn() as c:
        cur = c.execute("INSERT INTO controles(date_heure,utilisateur_id,modele_id,statut,score_global,detail_json)"
                        " VALUES(?,?,?,?,?,?)", (db.now(), user["login"], modele_id, res.statut, res.score_global,
                                                 db.dumps({"codes": res.codes, "scores": res.scores, "aligne": res.aligne,
                                                           "texte_modele": res.texte_modele, "texte_recu": res.texte_recu})))
        cid = cur.lastrowid
        folder = config.ARCHIVE_PATH / f"controle_{cid}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "etiquette_recue.png").write_bytes(cv2.imencode(".png", img)[1].tobytes())
        cv2.imwrite(str(folder / "modele_rendu.png"), res.model_img)
        cv2.imwrite(str(folder / "etiquette_alignee.png"), res.recv_aligned)
        (folder / "ecarts.jpg").write_bytes(cv2.imencode(".jpg", res.overlay)[1].tobytes())
        c.execute("UPDATE controles SET image_path=?, overlay_path=? WHERE id=?",
                  (str(folder / "etiquette_recue.png"), str(folder / "ecarts.jpg"), cid))
        for e in res.ecarts:
            c.execute("INSERT INTO ecarts(controle_id,zone,type_ecart,criticite,valeur_attendue,valeur_trouvee)"
                      " VALUES(?,?,?,?,?,?)", (cid, e["zone"], e["type_ecart"], e["criticite"],
                                               e["valeur_attendue"], e["valeur_trouvee"]))
        if scan_file:  # le scan est traite : on le range avec le controle pour qu'il ne soit pas reutilise
            (folder / f"scan_origine{scan_file.suffix.lower()}").write_bytes(data)
            scan_file.unlink()
        db.audit(c, user["login"], "controle", f"id={cid} modele={modele_id} statut={res.statut}",
                 request.client.host if request.client else "")
    return _controle(cid)


def _controle(cid: int) -> dict:
    with db.conn() as c:
        r = c.execute("SELECT * FROM controles WHERE id=?", (cid,)).fetchone()
        if not r:
            raise HTTPException(404, "Controle inconnu")
        ecarts = [dict(e) for e in c.execute("SELECT * FROM ecarts WHERE controle_id=? ORDER BY criticite DESC, id", (cid,))]
        v = c.execute("SELECT * FROM validations WHERE controle_id=? ORDER BY id DESC", (cid,)).fetchone()
        m = c.execute("SELECT nom_produit, ref_produit FROM modeles_pdf WHERE id=?", (r["modele_id"],)).fetchone()
    import json
    out = {k: r[k] for k in ("id", "date_heure", "utilisateur_id", "modele_id", "statut", "score_global")}
    out.update(json.loads(r["detail_json"]), ecarts=ecarts, validation=dict(v) if v else None,
               modele_nom=(m["nom_produit"] or m["ref_produit"]) if m else "")
    return out


@app.get("/api/controles/{cid}")
def get_controle(cid: int, user: dict = Depends(auth.current_user)):
    return _controle(cid)


@app.get("/api/controles")
def liste_controles(limit: int = 50, user: dict = Depends(auth.current_user)):
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,date_heure,utilisateur_id,modele_id,statut,score_global FROM controles ORDER BY id DESC LIMIT ?", (limit,))]


@app.get("/api/controles/{cid}/image")
def image_ecarts(cid: int, user: dict = Depends(auth.current_user)):
    with db.conn() as c:
        r = c.execute("SELECT overlay_path FROM controles WHERE id=?", (cid,)).fetchone()
    if not r:
        raise HTTPException(404, "Controle inconnu")
    return FileResponse(r["overlay_path"], media_type="image/jpeg")


@app.get("/api/controles/{cid}/zone")
def zone(cid: int, box: str, user: dict = Depends(auth.current_user)):
    """Vignette modele | etiquette alignee pour un ecart (box = x,y,w,h)."""
    try:
        x, y, w, h = (int(v) for v in box.split(","))
    except ValueError:
        raise HTTPException(400, "box invalide")
    return Response(_crop_pair(cid, x, y, w, h), media_type="image/png")


def _crop_pair(cid: int, x: int, y: int, w: int, h: int) -> bytes:
    folder = config.ARCHIVE_PATH / f"controle_{cid}"
    a, b = cv2.imread(str(folder / "modele_rendu.png")), cv2.imread(str(folder / "etiquette_alignee.png"))
    if a is None or b is None:
        raise HTTPException(404, "Controle inconnu")
    m = 20
    x0, y0 = max(x - m, 0), max(y - m, 0)
    ca, cb = a[y0:y + h + m, x0:x + w + m], b[y0:y + h + m, x0:x + w + m]
    sep = np.full((ca.shape[0], 8, 3), (0, 0, 255), np.uint8)
    return cv2.imencode(".png", np.hstack([ca, sep, cb]))[1].tobytes()


class Decision(BaseModel):
    decision: str  # ACCEPTE | REFUSE
    commentaire: str = ""


@app.post("/api/controles/{cid}/validation")
def valider(cid: int, d: Decision, request: Request, user: dict = Depends(auth.current_user)):
    if d.decision not in ("ACCEPTE", "REFUSE"):
        raise HTTPException(400, "decision doit etre ACCEPTE ou REFUSE")
    c0 = _controle(cid)
    if d.decision == "ACCEPTE" and c0["statut"] != "CONFORME":
        if user["role"] == "operateur":
            raise HTTPException(403, "Seul un superviseur peut accepter une etiquette non conforme ou a revoir")
        if not d.commentaire.strip():
            raise HTTPException(400, "Un commentaire est obligatoire pour accepter une etiquette non conforme")
    when = db.now()
    with db.conn() as c:
        c.execute("INSERT INTO validations(controle_id,utilisateur_id,date,decision,commentaire,signature_hash)"
                  " VALUES(?,?,?,?,?,?)", (cid, user["login"], when, d.decision, d.commentaire, db.sign(cid, user["login"], d.decision, when)))
        db.audit(c, user["login"], "validation", f"id={cid} {d.decision}", request.client.host if request.client else "")
    return _controle(cid)


@app.get("/api/controles/{cid}/rapport")
def rapport(cid: int, request: Request, user: dict = Depends(auth.current_user)):
    ctl = _controle(cid)
    with db.conn() as c:
        m = dict(c.execute("SELECT * FROM modeles_pdf WHERE id=?", (ctl["modele_id"],)).fetchone())
        ov = c.execute("SELECT overlay_path FROM controles WHERE id=?", (cid,)).fetchone()["overlay_path"]
    def crop_of(z):
        return _crop_pair(cid, *(int(v) for v in z.split(",")))
    pdf = report.build(ctl, m, ctl["ecarts"], ctl["validation"], Path(ov).read_bytes(), crop_of)
    path = config.ARCHIVE_PATH / f"controle_{cid}" / "rapport.pdf"
    path.write_bytes(pdf)
    with db.conn() as c:
        c.execute("INSERT INTO rapports(controle_id,chemin_pdf,date_generation,hash_sha256) VALUES(?,?,?,?)",
                  (cid, str(path), db.now(), hashlib.sha256(pdf).hexdigest()))
        db.audit(c, user["login"], "rapport", f"id={cid}", request.client.host if request.client else "")
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="controle_{cid}.pdf"'})


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
