"""python -m server            : demarre l'application
python -m server user add LOGIN MOTDEPASSE ROLE [NOM]   : cree/modifie un compte (operateur|superviseur|admin)
python -m server user list    : liste les comptes"""
import sys

from . import auth, db


def main(argv: list[str]) -> int:
    if argv[:1] == ["user"]:
        db.init()
        if argv[1:2] == ["add"] and len(argv) >= 5:
            auth.add_user(argv[2], argv[3], argv[4], argv[5] if len(argv) > 5 else "")
            print(f"Compte {argv[2]} ({argv[4]}) enregistre.")
        elif argv[1:2] == ["list"]:
            with db.conn() as c:
                for r in c.execute("SELECT login_ad, role, actif FROM utilisateurs ORDER BY login_ad"):
                    print(f"{r['login_ad']:20} {r['role']:12} {'actif' if r['actif'] else 'desactive'}")
        else:
            print(__doc__)
            return 2
        return 0
    import os
    import uvicorn
    uvicorn.run("server.main:app", host=os.environ.get("LABELQC_HOST", "0.0.0.0"),
                port=int(os.environ.get("LABELQC_PORT", "8000")), log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
