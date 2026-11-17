# Éditeur de documents structurés pour la GED

Prototype d'un éditeur de documents **sans Word ni Excel** : chaque document est un JSON structuré
(cartouche standard + corps configurable) que la GED stocke, vise et versionne, et qui produit un PDF fidèle.

Il a été construit à partir de quatre documents réels, repris comme modèles pilotes :

| Réf. | Type | Ce qu'il démontre |
|---|---|---|
| **K.08.111** | Grille de 8 cadres, **paysage**, 11 pages | Section répétable (1 mise en page, 11 instances), contenus partagés, jeux VPM 1 / 2 / 3, surcharge par instance |
| **K.08.100** | Procédure narrative avec photos, 6 p. | Titres numérotés, encadré « Attention », rangées de photos, plan, renvoi GED `[[K.16.001]]` |
| **K.08.104** v2 | Fiche courte | Fiche clé/valeur, aperçu de l'annexe A.134 *généré depuis l'annexe en vigueur*, marques ☞ « modifié dans cette version » |
| **A.134** v3 | Annexe-formulaire recto-verso | Une carte définie **une fois**, imprimée 4 par feuille A4, recto-verso, QR vers la version en vigueur |

## Lancer

```bash
npm install
npm install --no-save playwright        # rendu PDF (Chromium ≥ 131 requis, voir « Limites »)
npx playwright install chromium         # inutile si Chromium est déjà présent (variable CHROMIUM_PATH)
npm start                               # http://localhost:3000   (PORT=… pour changer)
npm test                                # 19 tests (workflow, rendu)
```

Au premier démarrage, les quatre documents sont écrits dans `data/` (ignoré par git). `node seed/index.js --force`
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

## Organisation du code

| Chemin | Rôle | Réutilisable tel quel dans la GED ? |
|---|---|---|
| `src/render.js` | Document JSON → HTML (aperçu navigateur **et** PDF, même code) | **Oui** |
| `src/workflow.js` | Visas, empreintes, révisions | **Oui** (Node) |
| `src/diff.js` | Forme canonique, détection des blocs modifiés | **Oui** |
| `schema/document.schema.json` | Contrat du format (JSON Schema 2020-12) | **Oui** |
| `public/` | Éditeur web (HTML/JS sans framework) | À intégrer, voir ci-dessous |
| `server.js` | Stockage fichiers, annuaire factice, API, PDF | **Non** : à remplacer par les services de la GED |
| `seed/` | Les quatre documents pilotes transcrits | Exemples de modèles |

Détails du modèle de données, du workflow et du plan de reprise de l'existant : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Limites connues (prototype)

Ce qui n'est **pas** fait, pour ne pas surestimer l'état du projet :

1. **Pas d'outil de migration Word/Excel/PowerPoint → JSON.** Les quatre documents ont été transcrits à la main à partir des
   PDF ; les sources Word n'étaient pas disponibles. Le taux de conversion automatique reste à mesurer sur vos `.docx`/`.xlsx`.
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
