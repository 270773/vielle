// K.08.104 v2 — Standard « Cartes action » (fiche courte, 2 pages). L'aperçu de la carte vient de l'annexe A.134 en vigueur.
import { H, UL, OL, CHECKLIST, KV, COLS } from './helpers.js';

export default {
  kind: 'document',
  layout: { orientation: 'portrait' },
  status: 'en_vigueur',
  workflow: { redacteur: 'CVE', examinateur: 'FBU', approbateur: 'DDE' },
  meta: {
    ref: 'K.08.104', version: 2, society: 'LIS France',
    title: 'MODE OPÉRATOIRE : STANDARD « CARTES ACTION »',
    dest: ['Mix & Pack', 'Séchage', 'Logistique', 'Maintenance', 'Labo'],
    keywords: ['Utilisation', 'Carte', 'Action'],
    service: 'Excelis', created: '2017-02-21', effective: '2025-01-28',
    annule: { version: 1, date: '2017-02-21' },
    annexes: [{ ref: 'A.134' }],
    changeNote: 'Ajout du rituel mensuel « GO / NO GO » : objectif 4 et étapes 4, 5 et 6 (marquées ☞).',
    migration: {
      source: 'K08104-2.pdf (2 pages) — sources Word non fournies',
      notes: [
        'La carte A.134 était une image collée (ancienne version, sans l’objet « économie d’énergie »). Remplacée par un aperçu généré depuis l’annexe A.134 en vigueur : plus de dérive de version.',
        'Marques ☞ d’origine reprises comme « modifié dans cette version » (éléments marqués « ! »). Dès la v3, elles seront calculées automatiquement.',
        'Bloc « Annexes » ajouté (liste automatique des annexes liées).',
      ],
    },
  },
  visas: [],
  body: [
    COLS([2, 3], [
      [{ type: 'keyvalue', bordered: false, rows: [
        ['QUOI :', 'Les cartes actions'],
        ['LIEU :', 'Les cartes sont affichées sur le panneau Excelis de la zone'],
        ['QUI :', 'Toute personne travaillant ou intervenant dans la zone'],
        ['QUAND :', 'Lorsqu’un problème est identifié et qu’une amélioration souhaite être proposée.'],
        ['DURÉE :', '2 min'],
      ] }],
      [{ type: 'annexpreview', ref: 'A.134', face: 'recto', count: 2, zoom: 0.5 }],
    ]),
    H('OBJECTIFS :', 1, false),
    CHECKLIST([
      'Remonter tout problème identifié sur la zone et proposer une solution,',
      'Echanger avec les autres personnes travaillant sur la ligne afin de favoriser la solution collective,',
      'S’informer des dernières modifications ayant été faites sur la ligne,',
      '! **Améliorer la réactivité au traitement des demandes par la mise en place d’un rituel « GO / NO GO » entre le CDP / Resp. et ou adjoint Resp. Production et Responsable EXCELIS (occasionnellement) mensuellement.**',
    ]),
    H('DÉROULEMENT :', 1, false),
    OL([
      'Lorsque je détecte un problème sur ma ligne et que je souhaite proposer une solution ou amélioration de l’ordre de la sécurité, qualité, ergonomie, organisationnelle…je peux émettre une carte ACTION.',
      'J’explique le problème rencontré et ma proposition pour le solutionner.',
      'J’affiche la carte à l’emplacement réservé sur le panneau EXCELIS de la zone concernée.',
      '! **Chaque carte ACTION émise est étudiée lors du rituel « GO / NO GO », où sont présents le CDP en poste / Resp. et ou adjoint Resp. Production et Coordinateur EXCELIS. A l’issue de ce rituel, la carte sera complétée et si elle est retenue elle est intégrée au plan d’action site par le leader de la zone.**',
      '! **Une décision finale sera prise lors du rituel mensuel de priorisation des cartes actions site, a l’issue de ce rituel une réponse à la solution proposée sera indiquée (GO = on lance une action, GO en attente (s’il y a déjà 2 actions retenues en cours), NO GO = l’action proposée n’est pas retenue et doit être modifiée dans le plan d’action site par le leader de la zone).**',
      '! **Chaque carte est mise, une fois traitée, dans la bannette archivage et vous pouvez les consulter à tout moment.**',
    ], '{n}.'),
    { ...H('ANNEXES', 1, false), locked: true }, // imposé par le modèle
    { type: 'annexes', locked: true },
  ],
};
