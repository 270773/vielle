# Architecture

## Principe

Le document est une **donnée structurée** (JSON versionné) ; le PDF et l'aperçu en sont des rendus. Il n'y a ni pagination
à gérer à la main, ni mise en forme dépendante d'Office. Le schéma de référence est `schema/document.schema.json`.

```
Document
├── kind        document | annex-card
├── status      brouillon → en_verification → en_approbation → en_vigueur → annule
├── workflow    { redacteur, examinateur, approbateur }        ← désignés par la GED
├── meta        ref, version, titre, société, destinataires, mots-clés, service, dates, annexes liées
├── visas[]     { role, userId, name, function, date, hash }    ← posés par le workflow, jamais saisis
├── body[]      blocs (documents)        │  card.faces[] + print  (annexes-cartes)
└── layout      orientation portrait | paysage
```

## Cartouche

| Partie | Où | Source |
|---|---|---|
| En-tête courant : société, Réf, Version, Page x / N | toutes les pages | `meta` + compteurs CSS |
| Identification : destinataires, mots-clés, titre | haut de la page 1 | `meta` (titre, destinataires, mots-clés éditables) |
| Visas : création, rédacteur, examinateur + fonction, approbateur + fonction, service, date d'effet, version annulée | pied de la page 1 | `meta` + `visas` (non éditable) |

Rendu : boîtes de marge `@page` (`@top-left/center/right`, `@page :first { @bottom-… }`). Les cellules latérales de
l'en-tête sont **symétriques** : la cellule centrale est centrée sur la page par le moteur, des largeurs asymétriques
laissent des interstices.

## Blocs

`heading` · `text` · `list` (puces, numéros `{n}.` `{n}>`, coches) · `callout` · `keyvalue` · `table` · `columns` ·
`box` · `photos` · `image` · `docref` · `annexes` · `annexpreview` · `checklist` · `fields` · `checks` · `area` ·
`choice` · `yesno` · `visatable` · `pagebreak` · `spacer` · `repeat` (+ `slot`).

- **Numérotation toujours automatique** (titres, listes) : supprime les erreurs de numérotation manuelle. Dans le K.08.111
  d'origine, l'agenda était numéroté 1, 2, 3, 4, **3**, 5 ; il sort désormais 1 à 6 ou 1 à 7.
- **Éléments de liste** : `~ texte` = ligne de suite, `! texte` = « modifié dans cette version » (☞).
- **Renvois** : `[[K.16.001]]` dans un texte, ou bloc `docref`. Titre et version viennent de la GED ; introuvable = signalé.
- **Colonnes** : `widths: [1, 1, 2]` fixe le nombre et les proportions ; chaque colonne contient des blocs.
- **`locked: true`** : bloc imposé par le modèle (non modifiable hors « mode concepteur »).

### Section répétable (`repeat`)

Une mise en page (`layout`, avec des `slot`) + des contenus résolus dans cet ordre : **instance → jeu (`presets`) → partagé
(`shared`)**. Modifier un contenu partagé met à jour toutes les instances qui ne le surchargent pas ; une instance peut
surcharger un seul emplacement. C'est le mécanisme du K.08.111 : 11 pages, une référence, une chaîne de visas.

### Annexes-cartes (`annex-card`)

Une carte = des faces (`recto`, `verso`) de blocs. La feuille est générée : `print.perSheet` (1, 2, 4), traits de coupe,
verso en miroir pour l'impression recto-verso, QR vers la version en vigueur. Les documents qui citent l'annexe
affichent un **aperçu rendu depuis l'annexe en vigueur** (`annexpreview`), jamais une image collée : plus de dérive de
version (l'image de la carte dans le K.08.104 v2 était une v1 de l'annexe, sans « économie d'énergie »).

## Workflow de visa

- Ordre imposé ; un visa n'est accepté que de l'utilisateur désigné pour le rôle attendu.
- Le visa **fige** nom et fonction (FAR : Responsable Technique en 2015, Directeur Général en 2025 : les anciens documents
  gardent la fonction de leur époque).
- Empreinte = SHA-256 de la forme canonique du contenu. Exclus : statut, visas, date d'effet, notes de migration
  (posés après le visa). `verifyIntegrity()` détecte toute modification a posteriori.
- `PUT` sur une version non brouillon → `409`. `revise()` crée la version N+1 en brouillon (visas vidés, `annule` = N,
  marques « ! » retirées). À la mise en vigueur de N+1, la version N passe à `annule`.
- **Diff** : `changedBlockIds()` compare par `id` les blocs de premier niveau de deux versions ; l'aperçu et le PDF
  affichent ☞ en marge. L'éditeur le recalcule en direct pendant la rédaction.

## API (prototype)

```
GET  /api/documents                       liste (dernière version de chaque référence)
GET  /api/documents/:ref?v=N              document + intégrité + prochain visa + blocs modifiés
PUT  /api/documents/:ref                  enregistre un brouillon (validé par le schéma)
POST /api/documents/:ref/visa?v=N         { user } → visa du rôle attendu
POST /api/documents/:ref/revise           nouvelle version
GET  /api/documents/:ref/pdf?v=N          PDF
POST /api/render/pdf                      PDF d'un brouillon non enregistré
POST /api/assets                          dépôt d'image (corps binaire)
GET  /api/catalog, /api/users             documents en vigueur, annuaire
```

## Intégration dans la GED

1. Importer `src/render.js`, `src/workflow.js`, `src/diff.js` et `schema/` tels quels.
2. Remplacer `server.js` : stockage (fichier ou table JSON versionnée), droits, annuaire réel, authentification.
3. Servir `public/` (ou l'encapsuler dans un composant web / une iframe) en lui donnant le même contrat d'API.
4. Alimenter `meta` et `workflow` depuis les métadonnées de la GED ; ne jamais accepter `status`, `visas`, `workflow`,
   `meta.created/effective/annule` depuis le client (c'est déjà le cas dans `PUT`).
5. Appliquer côté serveur les blocs `locked` en comparant le document reçu au modèle.

## Reprise de l'existant (à construire)

Approche proposée : migration **assistée par lots, par gabarit**, avec rapport d'écart par document.

| Source | Outil | Remarques observées sur les quatre documents pilotes |
|---|---|---|
| `.doc` / `.xls` / `.ppt` (binaires) | LibreOffice headless → `.docx` / `.xlsx` / `.pptx` | l'annexe A.134 est un `.doc` 97-2003 |
| Word | `mammoth` / pandoc : styles → blocs | les cases à cocher sont des caractères de police (Wingdings) ; une carte était dessinée 4 fois (72 zones de texte) : à reconstruire plutôt qu'à convertir |
| Excel | `openpyxl` : ligne → point de contrôle | le plan de nettoyage est un objet Excel collé en image |
| PowerPoint | diapositive → étape | — |

Chaque lot produit des notes de migration (`meta.migration.notes`, visibles dans l'éditeur, jamais imprimées) : société
d'origine différente, chemin réseau à remplacer par un lien GED, numérotation incohérente corrigée, image basse résolution,
document cité non encore migré, etc. Le fichier d'origine reste conservé en lecture seule.

Commencer par 20 à 30 documents représentatifs pour calibrer les règles par gabarit avant le lot complet.
