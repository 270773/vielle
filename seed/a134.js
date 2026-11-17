// A.134 v3 — Annexe « Carte action » : UNE carte (recto + verso) définie une fois ;
// la feuille imprimée (4 cartes, recto-verso) est générée. Remplace 72 zones de texte du .doc d'origine.
export default {
  kind: 'annex-card',
  status: 'brouillon',
  workflow: { redacteur: 'CVE', examinateur: 'DDE', approbateur: 'FAR' },
  meta: {
    ref: 'A.134', version: 3, society: 'LIS France', logo: '/assets/seed/logo-lis.jpg',
    title: 'CARTE ACTION\nEXCELIS',
    service: 'Excelis', created: '2026-11-06', effective: null, annule: null, annexes: [],
    migration: {
      source: 'A134-3_1.doc (Word 97-2003, 2 pages, 4 cartes identiques par page)',
      notes: [
        '4 cartes dessinées 4 fois (72 zones de texte, 16 dessins) → 1 définition de carte ; la mise en page « 4 par feuille, recto-verso » est générée à l’impression.',
        'Cases à cocher : caractères de police (type Wingdings) dans l’original → vraies cases dessinées, indépendantes de la police.',
        'Date de création = métadonnées du fichier .doc (à confirmer). Circuit de visa copié de K.08.104 (à confirmer).',
        'Liste « Objet » en v3 : ajout de « économie d’énergie » (absent de l’image collée dans K.08.104 v2).',
      ],
    },
  },
  visas: [],
  card: {
    faces: [
      {
        id: 'recto',
        header: { left: 'logo', title: 'CARTE ACTION\nEXCELIS' },
        blocks: [
          { type: 'fields', items: [{ label: 'Nom :' }, { label: 'Prénom :' }] },
          { type: 'fields', items: [{ label: 'Date :' }] },
          { type: 'spacer', height: '3mm' },
          { type: 'checks', label: 'Objet', cols: 2, options: ['sécurité', 'qualité', 'ergonomie', 'production', 'environnement', 'maintenance', 'flux', '', 'autre……………………', '', 'économie d’énergie', ''] },
          { type: 'spacer', height: '1mm' },
          { type: 'area', label: 'Quel est le problème ?' },
          { type: 'area', label: 'Quelle est votre proposition ?' },
        ],
      },
      {
        id: 'verso',
        header: { left: [{ type: 'choice', options: ['GO', 'NO GO'], number: true }], title: 'REPONSE' },
        blocks: [
          { type: 'fields', items: [{ label: 'Pilote & Nom :' }, { label: 'Visa CDP :' }] },
          { type: 'fields', items: [{ label: 'Date :' }, { label: 'Prénom :' }] },
          { type: 'area', label: 'SOLUTION RETENUE', shade: true },
          { type: 'columns', widths: [1, 1], cells: [[], [{ type: 'yesno', label: 'DI' }, { type: 'fields', items: [{ label: 'n° DI :' }] }, { type: 'fields', items: [{ label: 'Délai :' }] }]] },
          { type: 'yesno', label: 'Besoin accord', centered: true },
          { type: 'text', text: '**INTER-EQUIPE ou INTER-SERVICE**' },
          { type: 'visatable', columns: ['Equipe ou service', 'Visa accord'], rows: 4 },
          { type: 'area', label: 'VALIDATION REALISATION', shade: true, grow: false },
          { type: 'fields', items: [{ label: 'Nom(s) :' }] },
          { type: 'fields', items: [{ label: 'Date :' }, { label: '' }] },
          { type: 'yesno', label: 'Archivage', right: true },
        ],
      },
    ],
  },
  print: { perSheet: 4, cutMarks: true, mirrorVerso: true, qr: true, formats: ['pdf'] },
};
