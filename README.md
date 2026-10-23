# LabelQC

Contrôle de conformité des étiquettes à réception : comparaison d'une étiquette reçue (scan/photo)
avec un modèle PDF de référence. Voir le dossier technique `DT-LABELQC-2026-001`.

## Mise en service

1. **Installer** : `deploy\install.bat` (Windows, Python 3.11+) — ou `docker build -t labelqc .` (Linux).
   Aucun pack de langue ni Tesseract n'est nécessaire.
2. **Configurer** `config.env` : `LABELQC_PDF_ROOT` (dossier réseau des modèles), `LABELQC_SCAN_INBOX` (dossier où le scanner
   dépose ses fichiers, réglage « scan vers dossier »).
3. **Démarrer** : `deploy\start.bat` (ou `deploy\service.bat` pour un service Windows). Au premier démarrage, le compte
   `admin` est créé et son mot de passe affiché une fois (ou fixé par `LABELQC_ADMIN_PASSWORD`).
4. **Comptes** : `python -m server user add LOGIN MOTDEPASSE operateur|superviseur|admin "Nom"`.
   Opérateur : contrôle ; superviseur : peut aussi accepter une étiquette non conforme (commentaire obligatoire) ;
   admin : tout. Sessions de 8 h (cookie), connexions et décisions tracées dans le journal d'audit.
5. **Utiliser** : ouvrir `http://<serveur>:8000`, choisir le scan déposé (ou un fichier), « Contrôler ». Le modèle est détecté
   automatiquement ; le rapport PDF est généré à la demande.
6. **HTTPS** : placer l'application derrière le reverse proxy/certificat interne de l'entreprise (non fourni).

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

## Détection automatique du modèle

Les modèles (PDF d'imprimeur ou images) sont déposés n'importe où sous `LABELQC_PDF_ROOT` (dossier réseau) ; ils sont
indexés automatiquement. Le **nom du produit** et le **code d'étiquette** sont déduits du nom du fichier
(`737042-…-ETIQ_INVENTIS_PREMIX_RUSTIC_5__F701007_…pdf` → « INVENTIS PREMIX RUSTIC 5 », codes `737042 F701007`),
ou d'un fichier `<nom>.json` voisin (`{"nom": "...", "code": "..."}`).
`POST /api/controles` sans `modele_id` identifie le modèle : code-barres lu sur l'étiquette + ressemblance visuelle
(indépendant de la langue). `q` (nom/code, facultatif) restreint la recherche. Si le modèle n'est pas identifié avec
certitude, l'API répond 409 avec les candidats. `GET /api/modeles?q=` recherche par nom ou code ;
`POST /api/identifier` renvoie les candidats classés.

## Scan de l'étiquette reçue (méthode recommandée)

- Régler le scanner en « scan vers dossier » (PNG, JPEG, TIFF ou PDF, 300–600 dpi, couleur) vers `LABELQC_SCAN_INBOX`
  (`data/scans_entrants`). `GET /api/scans` liste les scans ; `POST /api/controles` accepte `scan=<nom>` : le scan est
  analysé puis rangé avec le contrôle. Une étiquette posée au milieu d'une feuille A4 est détourée automatiquement.
- Les images peuvent aussi être envoyées directement (`image=`), y compris des photos.

## Langues : rien à installer

Par défaut la vérification est **purement visuelle** (`LABELQC_OCR=off`) : zones de texte, symboles, logos et couleurs
sont comparés à l'image du modèle, donc quelle que soit la langue ou l'écriture, sans pack de langue.
Chaque écart est localisé et le rapport affiche une vignette « modèle | étiquette ».
Option : `LABELQC_OCR=on` (+ `pip install -r requirements-ocr.txt`, Tesseract et ses packs) pour obtenir en plus le texte
exact des écarts (`H225` ≠ `H226`).

**Recommandé : scan à plat.** Sur photo (éclairage, netteté, perspective), la comparaison visuelle produit beaucoup de
fausses alertes.

## Écart avec le dossier technique (à décider)

Écarts avec le dossier technique : SQLite à la place de SQL Server, comptes locaux à la place d'Active Directory,
interface web à la place d'Electron/WPF, scanner via dossier d'entrée (pas de pilote TWAIN direct), archives non chiffrées,
HTTPS à fournir par l'infrastructure.
