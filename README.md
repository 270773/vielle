# LabelQC

Contrôle de conformité des étiquettes à réception : comparaison d'une étiquette reçue (scan/photo)
avec un modèle PDF de référence. Voir le dossier technique `DT-LABELQC-2026-001`.

## Ce que fait cette première version

- **Modèles** : PDF ou image (BMP, PNG, JPEG) rangés en `data/modeles/{Fournisseur}/{Reference}/{Version}/modele.pdf` (ou `modele.bmp`, `.png`, `.jpg`), indexés automatiquement (MD5).
- **Pipeline** : redressement → recalage (ORB + homographie) → OCR Tesseract → comparaison mot à mot
  (codes H/P/EUH, chiffres, DANGER/ATTENTION = criticité 3) → lecture/comparaison codes-barres & QR (ZBar)
  → comparaison visuelle tolérante au décalage → score et statut `CONFORME` / `A_REVOIR` / `NON_CONFORME`.
- **Traçabilité** : décision opérateur signée (hash SHA-256), journal d'audit immuable (triggers SQL),
  rapport PDF horodaté, archivage image + écarts.
- **Interface web** servie par l'API (`/`), utilisable depuis un poste labo ou un smartphone.
- Traduction optionnelle via LibreTranslate (`LABELQC_LIBRETRANSLATE_URL`) si la langue de l'étiquette diffère du modèle.

## Lancer

```bash
pip install -r requirements.txt
# Tesseract (+ packs fra/eng/deu/spa) et ZBar doivent être installés sur la machine
cp config.env.example config.env
uvicorn server.main:app --host 0.0.0.0 --port 8000
pytest
```

## Scan de l'étiquette reçue (méthode recommandée)

- Régler le scanner en « scan vers dossier » (PNG, JPEG, TIFF ou PDF, 300–600 dpi, couleur) vers `LABELQC_SCAN_INBOX`
  (`data/scans_entrants`). `GET /api/scans` liste les scans ; `POST /api/controles` accepte `scan=<nom>` : le scan est
  analysé puis rangé avec le contrôle. Une étiquette posée au milieu d'une feuille A4 est détourée automatiquement.
- Les images peuvent aussi être envoyées directement (`image=`), y compris des photos.

## Langues

L'OCR et la comparaison fonctionnent dans toutes les langues dont le pack Tesseract est installé (`GET /api/langues`).
Un fichier optionnel `modele.json` à côté du modèle précise les langues imprimées :
`{"langue": "tr", "langues_etiquette": ["tr", "ar", "en"]}`. La comparaison mot à mot s'appuie sur l'image de chaque mot,
donc elle reste valable pour les écritures non latines (arabe, cyrillique, CJK…) tant que l'OCR les localise.

## Écart avec le dossier technique (à décider)

Cette version est un socle exécutable : SQLite à la place de SQL Server, en-tête `X-User` à la place d'Active Directory/JWT,
interface web à la place d'Electron/WPF, pas encore de scan TWAIN ni de chiffrement AES des archives.
