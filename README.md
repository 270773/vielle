# Éditeur de documents structurés pour la GED

Prototype d'un éditeur de documents **sans Word ni Excel** : chaque document est un JSON structuré
(cartouche standard + corps configurable) que la GED stocke, vise et versionne, et qui produit un PDF fidèle.

Il a été construit à partir de cinq documents réels, repris comme modèles pilotes :

| Réf. | Type | Ce qu'il démontre |
|---|---|---|
| **K.08.111** v1 → v2 | Grille de 8 cadres, **paysage**, 11 puis 12 pages | Section répétable (1 mise en page, 12 instances), contenus partagés, jeux VPM 1 / 2 / 3, surcharge par instance ; **comparaison v1 → v2 instance par instance** (☞ sur les grilles modifiées) |
| **K.08.100** | Procédure narrative avec photos, 6 p. | Titres numérotés, encadré « Attention », rangées de photos, plan, renvoi GED `[[K.16.001]]` |
| **K.08.104** v2 | Fiche courte | Fiche clé/valeur, aperçu de l'annexe A.134 *généré depuis l'annexe en vigueur*, marques ☞ « modifié dans cette version » |
| **A.134** v3 | Annexe-formulaire recto-verso | Une carte définie **une fois**, imprimée 4 par feuille A4, recto-verso, QR vers la version en vigueur |
| **K.08.110** v1 | Procédure en étapes avec captures d'écran annotées | Bloc « étapes illustrées » : numérotation continue, annotations (cercles, cadres, étiquettes) stockées comme **données** et non incrustées dans l'image. **Produit par le convertisseur** à partir du `.docx` |

## Lancer

```bash
npm install
npm install --no-save playwright        # rendu PDF (Chromium ≥ 131 requis, voir « Limites »)
npx playwright install chromium         # inutile si Chromium est déjà présent (variable CHROMIUM_PATH)
npm start                               # http://localhost:3000   (PORT=… pour changer)
npm test                                # 29 tests (workflow, rendu, convertisseur)
```

Au premier démarrage, les cinq documents sont écrits dans `data/` (ignoré par git). `node seed/index.js --force`
remet tout à zéro.

## Ce que fait l'éditeur

- **Cartouche en trois parties**, reprise de vos documents : en-tête courant (société, Réf, Version, *Page x / N*) sur
  toutes les pages ; bloc d'identification (destinataires, mots-clés, titre) en page 1 ; bloc de visas en pied de page 1.
  Tout est alimenté par la GED (🔒) : le rédacteur ne saisit que le titre, les destinataires, les mots-clés et le corps.
- **Corps configurable** par blocs : titres à numérotation automatique, texte, listes (puces, numéros `1>`, coches),
  encadrés, fiches clé/valeur, tableaux, **colonnes** (nombre et largeurs réglables), cadres titrés, photos (dépôt ou
  prise directe sur tablette), renvois vers d'autres documents, annexes, checklists et éléments de formulaire.
- **Visa interne** rédacteur → examinateur → approbateur : chaque visa enregistre le nom, la **fonction à la date du
  visa** (figée : un changement d'annuaire ne réécrit pas le passé), la date et l'empreinte SHA-256 du contenu visé.
  Une version visée n'est plus modifiable (l'API refuse avec `409`) : on crée une **nouvelle version**, qui annule la
  précédente à sa mise en vigueur.
- **Marqueur ☞ automatique** sur les blocs modifiés par rapport à la version précédente (remplace le marquage manuel).
- **PDF** par Chromium : A4 portrait ou paysage, cartouche paginé en boîtes de marge CSS `@page`.
- **Annexes imprimables** : feuille de N cartes (1, 2 ou 4), recto-verso, traits de coupe, verso en miroir,
  mention « copie imprimée non contrôlée » et QR vers la version en vigueur.
- **Tablette** : affichage adaptatif (onglets Édition / Aperçu), autosauvegarde après 2 s d'inactivité.

## Migration Word → JSON

```bash
npm run migrate -- K08110-1.docx K08104-2.doc --out data/documents --assets data/assets
#   --legacy-visas   importe le document « en vigueur » avec ses visas historiques (fonction figée)
#   --force          écrase une version déjà migrée
```

Les `.doc` sont d'abord convertis par LibreOffice (`soffice`). Le convertisseur lit **ce qui est structuré** dans le Word et
**signale ce qui ne l'est pas** (rapport affiché + `meta.migration.notes`, visible dans l'éditeur, jamais imprimé) :

- **cartouche** lu dans l'en-tête et le pied de page Word *par libellés* (les trois pieds de page rencontrés ont trois
  structures différentes) : référence, version, destinataires, mots-clés, titre, dates, rédacteur / examinateur /
  approbateur **avec leur fonction de l'époque**, version annulée ;
- **corps** : paragraphes, titres, listes (numérotées, à puces, coches), fiches « LIBELLÉ : valeur », tableaux de données,
  tableaux de mise en page aplatis (colonnes côte à côte conservées), tableaux d'étapes illustrées ;
- **images** extraites ; **formes d'annotation** (cercles, étiquettes) converties en annotations positionnées en % ;
- **marques ☞** (« modifié dans cette version ») rattachées à l'élément concerné.

Résultats sur vos quatre fichiers sources :

| Source | Cartouche | Corps converti automatiquement | À reprendre |
|---|---|---|---|
| `K08104-2.doc` | complet, identique à ma transcription manuelle | tout le texte (14 chaînes sur 15 identiques à ma transcription ; la 15ᵉ diffère par un espace que **j'avais ajouté**, le convertisseur est plus fidèle) ; 4 marques ☞ sur 4 | image de la carte → remplacée par l'aperçu de A.134 |
| `K08110-1.docx` | complet | 13 étapes, 12 captures, 14 annotations (positions vérifiées visuellement sur les premières pages, par comparaison avec le rendu Word) ; saut de numérotation d'origine (1–6, 8–14) signalé | — |
| `K08111-2.docx` | complet (v2, annule v1) | **les titres seulement** : les 12 grilles de 8 cadres sont des **images PNG collées** | 12 images (≈ 1230 × 640 px) : **retranscrites à la main** dans `seed/k08111-v2.js` (voir ci-dessous) ; 4 marques ☞ non rattachables |
| `A134-3.doc` | absent (référence déduite du nom de fichier) | planche de 8 cartes réduite à un exemplaire de chaque contenu | carte à reconstruire en annexe-carte (c'est fait dans le prototype) ; 4 zones de texte flottantes ignorées |

**K.08.111 v2 (retranscription).** Les 12 grilles ont été lues une à une et saisies dans le format structuré, puis comparées à la v1.
Résultat : **5 instances modifiées sur 12** (VPM 3 : 2f/semaine, mardi et jeudi, 8h30>9h, salle Aublettes… ; VPM 2 Séchage : participants ;
VPM 1 Labo : chef d'équipe, 14h00 ; VPM 1 Logistique : 9h30 ; **nouvelle** VPM 1 MTN Mix & Pack). L'auteur n'avait marqué ☞ dans le Word que
VPM 3 et MTN Mix & Pack : la comparaison automatique rattrape les trois autres. ⚠ Cette retranscription est **à relire intégralement** :
le texte des images n'est pas extractible automatiquement, et la v2 est construite à partir de la v1 en n'appliquant que les différences
relevées (tout texte jugé identique à la v1 ne l'a pas été re-saisi).

Conséquence pour la reprise : **le taux de conversion automatique dépend du mode de fabrication du document, pas de son type.**
Un Word construit avec de vrais tableaux, listes et formes (K.08.110, K.08.104) se convertit presque intégralement ; un Word
qui colle des images de tableaux (K.08.111) ne se convertit pas : il faut retranscrire. Le convertisseur le détecte et le dit.

## Organisation du code

| Chemin | Rôle | Réutilisable tel quel dans la GED ? |
|---|---|---|
| `src/render.js` | Document JSON → HTML (aperçu navigateur **et** PDF, même code) | **Oui** |
| `src/workflow.js` | Visas, empreintes, révisions | **Oui** (Node) |
| `src/diff.js` | Forme canonique, détection des blocs modifiés | **Oui** |
| `schema/document.schema.json` | Contrat du format (JSON Schema 2020-12) | **Oui** |
| `public/` | Éditeur web (HTML/JS sans framework) | À intégrer, voir ci-dessous |
| `server.js` | Stockage fichiers, annuaire factice, API, PDF | **Non** : à remplacer par les services de la GED |
| `tools/migrate/` | Convertisseur Word → JSON (CLI + bibliothèque) | **Oui** (Node) |
| `seed/` | Documents pilotes : quatre transcrits à la main, K.08.110 produit par le convertisseur (`seed/migrated/`) | Exemples de modèles |

Détails du modèle de données, du workflow et du plan de reprise de l'existant : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Limites connues (prototype)

Ce qui n'est **pas** fait, pour ne pas surestimer l'état du projet :

1. **Migration : seul le Word est couvert** (`.docx`, et `.doc` via LibreOffice). Pas d'Excel ni de PowerPoint. Le texte contenu dans
   des **images** n'est pas converti (K.08.111 : 11 grilles) : retranscription manuelle, OCR ou transcription assistée à prévoir.
   Pour le K.08.111 v2, la retranscription des images est faite mais **non relue** (voir ci-dessus).
   Les annotations sont placées par données numériques ; pas encore de déplacement à la souris dans l'aperçu.
2. **Export Word et Excel des annexes non implémenté** : seul le PDF est produit. Le champ `print.formats` du schéma
   prévoit `docx` et `xlsx` pour plus tard.
3. **Authentification et annuaire simulés** : le menu « Connecté en tant que » choisit un utilisateur factice. Les rôles du
   circuit de visa sont contrôlés côté serveur, mais sur cette identité déclarée.
4. **Blocs verrouillés (`locked`) appliqués par l'éditeur uniquement.** Le serveur n'empêche pas un client malveillant de les
   modifier : en production, comparer le document reçu au modèle.
5. **Édition de texte simplifiée** (zones de texte + mini-balisage `**gras**`, `__souligné__`, `[[REF]]`). Pour la
   production : ProseMirror/TipTap avec des nœuds personnalisés.
6. **Bloc de visas en pied de page 1** et **en-tête paginé** reposent sur les boîtes de marge `@page` : Chromium ≥ 131
   (testé avec 153). Dans l'aperçu à l'écran, la pagination exacte n'est pas simulée (le PDF fait foi).
7. **Visas des documents migrés** : la date de visa est celle de la mise en vigueur (les dates réelles ne figurent pas
   dans les PDF) ; l'annuaire ne contient que les initiales relevées sur les documents.
8. **Stockage en fichiers JSON**, sans gestion de la concurrence (un seul éditeur à la fois suppose un verrou GED).
9. **Testé** : tests unitaires (`npm test`) + un parcours complet dans Chromium (édition, visas, verrouillage, nouvelle
   version, photo, contenu partagé, surcharge) ; affichage tablette vérifié à 820 px. Non testé sur de vrais appareils tactiles.
