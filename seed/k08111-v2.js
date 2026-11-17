// K.08.111 v2 — retranscription des 12 grilles collées en images dans K08111-2.docx (13 pages, paysage).
// Construit à partir de la v1 (ids conservés) en appliquant les seules différences relevées sur les images.
// ⚠ Transcription à relire : le texte des images n'est pas extractible automatiquement.
import { gen, part, ul } from './k08111.js';

const bold = (s) => `**${s}**`;

export default function toV2(v1) {
  const doc = structuredClone(v1);
  doc.meta.version = 2;
  doc.meta.annule = { version: 1, date: '2025-04-10' };
  doc.meta.effective = '2025-04-10';
  doc.meta.changeNote = 'VPM 3 : fréquence 2f/semaine, mardi et jeudi, 8h30>9h, 30 min maxi, salle Aublettes ; participants, entrées, sorties et agenda précisés. VPM 2 Séchage : participants. Nouvelle instance VPM 1 – MTN Mix & Pack. VPM 1 Labo : chef d’équipe, 14h00, 15 min. VPM 1 Logistique : 9h30.';
  doc.meta.migration = {
    source: 'K08111-2.docx (13 pages) — 12 grilles collées en images PNG, retranscrites',
    notes: [
      'Les 12 grilles étaient des IMAGES dans le Word : leur texte a été retranscrit à la main depuis les images. À relire intégralement avant mise en vigueur.',
      'Une 12ᵉ instance apparaît par rapport à la v1 : « VPM 1 – MTN Mix & Pack ».',
      'Marques ☞ du Word d’origine : seulement VPM 3 (2) et MTN Mix & Pack (2). Les changements de VPM 1 Labo (chef d’équipe, 14h00, 15 min), VPM 1 Logistique (9h30) et VPM 2 Séchage (participants) n’avaient pas été marqués : la comparaison automatique les signale.',
      'Orthographe d’origine conservée (« a remonter », « Commandes a relancer », « règlementaires »).',
      'Agenda : numérotation d’origine incohérente (1, 2, 3, 4, 3, 5…) remplacée par la numérotation automatique.',
    ],
  };
  const rep = doc.body[0];
  const inst = (t) => rep.instances.find((i) => i.title === t);

  // VPM 3
  const v3 = inst('VPM 3');
  v3.slots.general = gen('2f/semaine', 'Mardi et jeudi', '8h30>9h', '30 min Maxi', 'Tableau VPM 3\nSalle Aublettes');
  v3.slots.participants = [
    { type: 'text', text: '**Leader :** Directeur technique (1>Back up Resp AC, 2>un membre de la VPM3 présent)' },
    { type: 'text', text: '**Participants** (si possible backup si Abs) :' },
    ...ul(['Directeur Tech · Resp. AC', 'Resp. séchage', 'Resp. Mix/Pack · Resp. LOG (1f/sem.)', 'Resp. MTN', 'Resp. Qualité · Resp. TN (1f/sem.)', 'Resp. sécurité + invités ponctuels']),
  ];
  const pre = rep.presets.VPM3;
  pre.entrees[0].items[3] = 'Remontée des problèmes bloquants pour décision';
  pre.sorties[0].items[3] = 'Déclenchement de RCA';
  const ag = pre.agenda[0].items;
  ag[0] = bold('Revue du plan d’action (top 24h/actions urgentes)');
  ag[2] = bold('priorisation des pb bloquants (identification des priorités à 24h et à moyen terme)');

  // VPM 2 – Séchage : points ajoutés aux libellés des participants
  inst('VPM 2 – Séchage').slots.participants = part(['Resp. séchage ou adjoint'], ['Resp. séchage ou adjoint · Ordo 1f/sem', 'CDP et/ou adjoint · Process 1f/sem', 'Coordinateur sécurité (2 f/sem)', 'Resp. MTN ou Chef d’équipe MTN', 'Resp Qualité séchage · Resp AC (2 f/sem)']);

  // VPM 1 – Labo et Logistique
  const labo = inst('VPM 1 – Labo');
  labo.slots.general = gen('Quotidienne', 'Lundi au vendredi', '14h00', '15 min', 'Tableau VPM 1');
  labo.slots.participants = part(['Chef d’équipe'], ['Membres du service/atelier']);
  inst('VPM 1 – Logistique').slots.general = gen('Quotidienne', 'Lundi au vendredi', '9h30', '15 min', 'Tableau VPM 1');

  // Nouvelle instance, après « MTN Séchage »
  const at = rep.instances.findIndex((i) => i.title === 'VPM 1 – MTN Séchage');
  rep.instances.splice(at + 1, 0, { title: 'VPM 1 – MTN Mix & Pack', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '14h00', '15 min', 'Tableau VPM 1'), participants: part(['Chef d’équipe'], ['Membres du service/atelier']) } });
  return doc;
}
