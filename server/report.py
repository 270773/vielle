"""Rapport PDF de controle."""
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

COLORS = {"CONFORME": colors.green, "A_REVOIR": colors.orange, "NON_CONFORME": colors.red}


def build(controle: dict, modele: dict, ecarts: list[dict], validation: dict | None, overlay_jpg: bytes | None) -> bytes:
    st = getSampleStyleSheet()
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm,
                            bottomMargin=15 * mm, title=f"Controle etiquette #{controle['id']}")
    s = [Paragraph("Rapport de controle d'etiquette", st["Title"]),
         Paragraph(f"Controle n° {controle['id']} — {controle['date_heure']}", st["Normal"]), Spacer(1, 6)]
    meta = [["Modele", f"{modele['fournisseur']} / {modele['ref_produit']} / v{modele['version']}"],
            ["Operateur", controle["utilisateur_id"]], ["Score global", f"{controle['score_global']} / 100"],
            ["Resultat automatique", controle["statut"]]]
    if validation:
        meta += [["Decision", f"{validation['decision']} par {validation['utilisateur_id']} le {validation['date']}"],
                 ["Commentaire", validation["commentaire"] or "-"], ["Signature", validation["signature_hash"][:32] + "…"]]
    t = Table(meta, colWidths=[45 * mm, 130 * mm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (0, -1), colors.whitesmoke),
                           ("TEXTCOLOR", (1, 3), (1, 3), COLORS.get(controle["statut"], colors.black))]))
    s += [t, Spacer(1, 8), Paragraph(f"Ecarts detectes ({len(ecarts)})", st["Heading2"])]
    if ecarts:
        rows = [["Crit.", "Zone", "Type", "Attendu", "Trouve"]] + [
            [str(e["criticite"]), e["zone"][:18], e["type_ecart"], Paragraph(e["valeur_attendue"][:120], st["BodyText"]),
             Paragraph(e["valeur_trouvee"][:120], st["BodyText"])] for e in ecarts]
        et = Table(rows, colWidths=[12 * mm, 25 * mm, 32 * mm, 52 * mm, 54 * mm], repeatRows=1)
        et.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                                ("VALIGN", (0, 0), (-1, -1), "TOP"), ("FONTSIZE", (0, 0), (-1, -1), 8)]))
        s.append(et)
    else:
        s.append(Paragraph("Aucun ecart.", st["Normal"]))
    if overlay_jpg:
        s += [Spacer(1, 8), Paragraph("Etiquette recue — ecarts en rouge", st["Heading2"]),
              Image(BytesIO(overlay_jpg), width=170 * mm, height=170 * mm, kind="proportional")]
    doc.build(s)
    return buf.getvalue()
