"""Comptes locaux, roles et sessions (cookie signe).

Roles : operateur (controle), superviseur (valide/accepte les non-conformes), admin (comptes).
L'annuaire Active Directory du dossier technique peut remplacer `verify_login` sans toucher au reste."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from fastapi import Depends, HTTPException, Request

from . import config, db

ROLES = ("operateur", "superviseur", "admin")
COOKIE = "labelqc_session"
SESSION_SECONDS = 8 * 3600


def _secret() -> bytes:
    env = os.environ.get("LABELQC_SECRET_KEY")
    if env:
        return env.encode()
    f = config.DB_PATH.parent / "secret.key"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(secrets.token_bytes(32))
    return f.read_bytes()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def _check_password(password: str, stored: str) -> bool:
    try:
        salt, h = (base64.b64decode(p) for p in stored.split("$"))
    except ValueError:
        return False
    return hmac.compare_digest(hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1), h)


def add_user(login: str, password: str, role: str, nom: str = "", prenom: str = "") -> None:
    if role not in ROLES:
        raise ValueError(f"role invalide ({', '.join(ROLES)})")
    if len(password) < 8:
        raise ValueError("mot de passe : 8 caracteres minimum")
    with db.conn() as c:
        c.execute("INSERT INTO utilisateurs(login_ad,nom,prenom,role,actif,date_creation,mdp_hash) VALUES(?,?,?,?,1,?,?) "
                  "ON CONFLICT(login_ad) DO UPDATE SET role=excluded.role, mdp_hash=excluded.mdp_hash, actif=1",
                  (login, nom, prenom, role, db.now(), hash_password(password)))
        db.audit(c, "systeme", "compte", f"{login} role={role}")


def ensure_admin() -> str | None:
    """Premier demarrage : cree le compte `admin` et renvoie son mot de passe initial (a changer)."""
    with db.conn() as c:
        if c.execute("SELECT 1 FROM utilisateurs WHERE actif=1 LIMIT 1").fetchone():
            return None
    pwd = os.environ.get("LABELQC_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    add_user("admin", pwd, "admin", "Administrateur")
    return pwd


def verify_login(login: str, password: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM utilisateurs WHERE login_ad=? AND actif=1", (login,)).fetchone()
    if r and r["mdp_hash"] and _check_password(password, r["mdp_hash"]):
        return {"login": r["login_ad"], "role": r["role"], "nom": f"{r['prenom'] or ''} {r['nom'] or ''}".strip()}
    _check_password(password, "AAAA$AAAA")  # temps constant approximatif : ne revele pas si le compte existe
    return None


def make_token(user: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps({**user, "exp": int(time.time()) + SESSION_SECONDS}).encode()).decode()
    return body + "." + hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()


def read_token(token: str) -> dict | None:
    try:
        body, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(sig, hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()):
            return None
        data = json.loads(base64.urlsafe_b64decode(body))
        return data if data["exp"] > time.time() else None
    except Exception:
        return None


def current_user(request: Request) -> dict:
    tok = request.cookies.get(COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    user = read_token(tok) if tok else None
    if not user:
        raise HTTPException(401, "Connexion requise")
    return user


def require(*roles: str):
    def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(403, f"Droits insuffisants (role requis : {' ou '.join(roles)})")
        return user
    return dep
