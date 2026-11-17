// K.08.111 — Agenda et règles pour les standards de VPM (11 pages dans l'original, paysage).
// Une seule grille de 8 cadres, répétée 11 fois. Les textes communs sont partagés ;
// seuls « Général » et « Participants » (et quelques écarts) varient par instance.
import { KV, BOX, COLS, SLOT } from './helpers.js';

const bold = (s) => `**${s}**`;
const agenda2 = (n) => ({ type: 'list', style: 'number', format: '{n}>', items: n });

const A_COMMUN = [
  bold('Revue du plan d’action (top 24h)'),
  bold('Revue des indicateurs SQCDME'),
  bold('Identification des écarts (identification des priorités à 24h et à moyen terme)'),
  bold('les priorités à 24h sont notées sur le tableau d’action top 24h'),
  bold('Revue des actions (moyen terme) et ajout éventuel de nouvelles actions'),
  '~ L’ensemble des actions sont revues et lues à l’équipe',
];
const TOUR = [bold('Informations diverses (projets, évènements à venir,…)'), '~ ' + bold('Tour de table'), '~ Chaque personne peut s’exprimer en fin de VPM'];

const REGLES_COMMUN = ['Commencer et finir à l’heure, venir préparé', 'Communication ouverte et honnête', 'Etre flexible et aider chacun à avancer', 'Challenger les faits pas les individus', 'Téléphone & ordinateur éteints', 'Ecoute, respect du temps de parole'];
const regles2 = ['Commencer et finir à l’heure, venir préparé', 'Venir préparé pour temps de parole efficace', 'Chaque personne est responsable pour délivrer ses propres actions en temps et en heure', ...REGLES_COMMUN.slice(1)];
const regles1 = ['Commencer et finir à l’heure, venir préparé', 'Ne pas analyser les problèmes lors de la VPM', 'Chaque personne est responsable pour délivrer ses propres actions en temps et en heure', ...REGLES_COMMUN.slice(1)];
const regles3 = ['Commencer et finir à l’heure, venir préparé', 'Ne pas analyser les problèmes lors de la VPM', 'Chaque personne est responsable de ses actions', ...REGLES_COMMUN.slice(1)];

const OBJ = [
  'Passer en revue les indicateurs SQCDME des 24 dernières heures',
  'Définir les priorités du jour et de la semaine',
  'Suivre le plan d’actions court-terme',
  'Partager les informations techniques du service',
  'Avoir une vision commune des évènements de l’atelier et du site',
];

export const ul = (items) => [{ type: 'list', style: 'bullet', items }];
export const gen = (freq, jour, heure, duree, loc) => [KV([['Fréquence :', freq], ['Jour :', jour], ['Heure :', heure], ['Durée :', duree], ['Localisation :', `**${loc}**`]])];
export const part = (leader, parts) => [{ type: 'text', text: '**Leader :**' }, ...ul(leader), { type: 'text', text: '**Participants :**' }, ...ul(parts)];

const SORTIES2 = ['Indicateurs à jour', 'Actions priorisées pour le jour (top 24h)', 'Actions priorisées pour la semaine', 'Problèmes/sujets à remonter en VPM3', 'Déclenchement de RCA', 'Planning des interventions communiqués', 'Informations principales partagées'];
const ENTREES2 = ['Indicateurs de la zone (SQCDME)', 'Fonctionnement depuis le début du poste', 'Remontées VPM1', 'Remontée et descente d’informations', 'Annonces, visites, évènements', 'Interventions MTN prévues'];

const repeat = {
  type: 'repeat',
  titleTemplate: 'AGENDA ET RÈGLE DE LA {title}',
  // Mise en page commune (fait partie du modèle : verrouillée pour les rédacteurs).
  layout: [
    COLS([30, 30, 40], [[BOX('1. Général :', [SLOT('general')])], [BOX('2. Participants :', [SLOT('participants')])], [BOX('3. Objectifs :', [SLOT('objectifs')])]]),
    COLS([43, 28, 29], [[BOX('4. Données d’entrée :', [SLOT('entrees')])], [BOX('5. Données de sortie :', [SLOT('sorties')])], [BOX('6. Indicateurs :', [SLOT('indicateurs')])]]),
    COLS([50, 50], [[BOX('7. Règles de base :', [SLOT('regles')])], [BOX('8. Agenda :', [SLOT('agenda')])]]),
  ],
  // Contenus partagés par défaut = niveau VPM 2 ; une modification ici s'applique aux 11 instances qui ne la surchargent pas.
  shared: {
    objectifs: ul(OBJ),
    entrees: ul(ENTREES2),
    sorties: ul(SORTIES2),
    indicateurs: ul(['Fonction de la zone', 'Les indicateurs sont variables en fonction des sujets principaux à traiter']),
    regles: ul(regles2),
    agenda: [agenda2([...A_COMMUN, ...TOUR])],
  },
  presets: {
    VPM1: {
      entrees: ul(['Indicateurs de la zone (SQCDME)', 'Fonctionnement depuis le début du poste', 'Remontée et descente d’informations', 'Annonces, visites, évènements']),
      sorties: ul(['Indicateurs à jour', 'Actions priorisées pour le jour (top 24h)', 'Actions priorisées pour la semaine', 'Problèmes/sujets à remonter en VPM2', 'Planning des interventions communiqués', 'Informations principales partagées']),
      regles: ul(regles1),
      agenda: [agenda2([...A_COMMUN, bold('Définition des problèmes a remonter en VPM 2'), ...TOUR])],
    },
    VPM3: {
      objectifs: ul([
        'Passer en revue les indicateurs sécurité',
        'Traiter les remontées des VPM 2 et problèmes divers',
        'Définir les priorités du jour et de la semaine',
        '~ (les priorités à 24h sont décidées par le collectif même en l’absence du Dir Tech, les actions moyen terme seront décidées en présence du Dir Tech)',
        'Suivre le plan d’actions 24h et moyen terme',
        'Partager les informations techniques du site',
        'Avoir une vision commune des évènements du site',
      ]),
      entrees: ul(['Indicateurs Sécurité', 'Indicateurs autres', 'Fonctionnement depuis le début du poste', 'Remontée de sujets des VPM 2 et pb divers pour décision', 'Remontée et descente d’informations', 'Annonces, visites, évènements']),
      sorties: ul(['Indicateurs sécurité à jour', 'Actions priorisées pour le jour (top 24h)', 'Actions priorisées a moyen terme (cartes T)', 'Déclenchement de RCA (pb récurrents)', 'Planning des interventions communiqué', 'Informations principales partagées']),
      regles: ul(regles3),
      agenda: [agenda2([
        bold('Revue du plan d’action (top 24h)'), bold('Revue des indicateurs Sécurité'),
        bold('Remontées VPM 2 et pb divers (identification des priorités à 24h et à moyen terme)'),
        bold('les priorités à 24h sont notées sur le tableau d’action top 24h'),
        bold('Revue des actions (moyen terme) et ajout éventuel de nouvelles actions (cartes T)'),
        '~ L’ensemble des actions sont revues et lues à l’équipe',
        bold('Informations diverses (projets, évènements à venir,…)'), bold('Tour de table'), '~ Chaque personne peut s’exprimer en fin de VPM',
      ])],
    },
  },
  instances: [
    { title: 'VPM 3', preset: 'VPM3', slots: {
      general: gen('3f/semaine', 'Mardi, mercredi et jeudi\nObj + vend à 6 mois', '11h30>12h', '30 min', 'Tableau VPM 3\nSalle Aublette'),
      participants: [{ type: 'text', text: '**Leader :** Directeur technique (1>Back up Resp AC, 2>un membre de la VPM3 présent)' }, { type: 'text', text: '**Participants** (si possible backup si Abs) :' }, ...ul(['Directeur Tech · Resp AC', 'Resp séchage', 'Resp Mix/Pack · Resp LOG (1f/sem)', 'Resp MTN', 'Resp Qualité · Resp TN le jeudi', 'Resp sécurité + invités ponctuels'])],
      indicateurs: ul(['En fonction de la zone', 'Les indicateurs sont variables en fonction des sujets principaux à traiter']),
    } },
    { title: 'VPM 2 – Séchage', slots: {
      general: gen('Quotidienne', 'Lundi au vendredi', '9h00>9h30', '30 min', 'Tableau VPM 2'),
      participants: part(['Resp séchage ou adjoint'], ['Resp séchage ou adjoint · Ordo 1f/sem', 'CDP et/ou adjoint · Process 1f/sem', 'Coordinateur sécurité (2 f/sem)', 'Resp MTN ou Chef d’équipe MTN', 'Resp Qualité séchage · Resp AC (2 f/sem)']),
    } },
    { title: 'VPM 2 – Mix & Pack', slots: {
      general: gen('Quotidienne', 'Lundi au vendredi', '10h00>10h15 MIX\n10h15>10h30 PACK', '30 min', 'Tableau VPM 2 Mix/pack'),
      participants: part(['Resp mix/pack ou adjoint'], ['Resp mix/pack et adjoint', 'CDP ou adjoint', 'Coordinateur sécurité (2f/sem)', 'Chef d’équipe MTN · Plannif/Ordo', 'Resp Qualité mix/pack · Resp AC (2f/sem)']),
    } },
    { title: 'VPM 2 – MTN', slots: {
      general: gen('Bi hebdo', 'Mardi et Jeudi', '11h00>11h30', '30 min', 'Tableau VPM 2 MTN'),
      participants: part(['Responsable Maintenance'], ['Resp d’équipe MTN séchage', 'Resp d’équipe MTN Mix/Pack', 'Assistantes magasin', 'Méthodes MTN', 'Automaticien', 'Services généraux']),
      entrees: ul(['Indicateurs de la zone (SQCDME)', 'Remontées VPM1', 'Remontée et descente d’informations', 'Annonces, visites, évènements']),
      sorties: ul(['Indicateurs à jour', 'Actions priorisées pour le jour (top 24h)', 'Actions priorisées pour la semaine', 'Problèmes/sujets à remonter en VPM3', 'Déclenchement de RCA', 'Informations principales partagées', 'Commandes a relancer', 'Planning contrôles règlementaires S+1']),
    } },
    { title: 'VPM 2 – Qualité / Labo', slots: {
      general: gen('Quotidienne', 'Lundi au vendredi', '17h>17h30 Maxi', '30 min', 'Tableau VPM 2 qualité'),
      participants: part(['Responsable qualité/Labo'], ['Responsables qualités/secteur', 'Responsable laboratoire', 'Autres membres de l’équipe']),
      sorties: ul(['Indicateurs à jour', 'Actions priorisées pour le jour (top 24h)', 'Actions priorisées pour la semaine', 'Problèmes/sujets à remonter en VPM3', 'Déclenchement de RCA', 'Planning des interventions communiqué', 'Informations principales partagées']),
    } },
    { title: 'VPM 1 – Mix', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '6h05/14h05/22h05', '10 min', 'Tableau VPM 1'), participants: part(['CDP'], ['Membres du service/atelier']) } },
    { title: 'VPM 1 – Pack', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '6h05/14h05/22h05', '10 min', 'Tableau VPM 1'), participants: part(['CDP'], ['Membres du service/atelier']) } },
    { title: 'VPM 1 – MTN Séchage', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '8h', '15 min', 'Tableau VPM 1'), participants: part(['Chef d’équipe'], ['Membres du service/atelier']) } },
    { title: 'VPM 1 – Labo', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '14h', '15 min Maxi', 'Tableau VPM 1'), participants: part(['Resp laboratoire'], ['Membres du service']) } },
    { title: 'VPM 1 – Spécialités', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '8h00 > 8h15\n13h30 > 13h45', '15 min', 'Tableau VPM 1'), participants: part(['Responsable spécialités'], ['Membres de l’équipe']) } },
    { title: 'VPM 1 – Logistique', preset: 'VPM1', slots: { general: gen('Quotidienne', 'Lundi au vendredi', '9h00', '15 min', 'Tableau VPM 1'), participants: part(['Responsable magasins/transports'], ['Membres du service']) } },
  ],
};

export default {
  kind: 'document',
  layout: { orientation: 'landscape' },
  status: 'en_vigueur',
  workflow: { redacteur: 'CVE', examinateur: 'DDE', approbateur: 'FAR' },
  meta: {
    ref: 'K.08.111', version: 1, society: 'LIS France',
    title: 'MODE OPÉRATOIRE : AGENDA ET RÈGLES POUR LES STANDARDS DE VPM',
    dest: ['Directeur Technique', 'Resp. Maintenance', 'Service Maintenance', 'Resp. Production', 'Adjoint Resp. Production', 'Service Qualité', 'CDP Mix & Pack', 'Salle Imprimantes', 'Coordinatrice Sécurité'],
    keywords: ['VPM', 'Standard', 'Règles', 'Agenda'],
    service: 'Excelis', created: '2025-04-10', effective: '2025-04-10', annule: null, annexes: [],
    migration: {
      source: 'K08111-1.pdf (11 pages) — sources Word non fournies',
      notes: [
        'Grille de 8 cadres répétée 11 fois : modélisée en une section répétable (1 mise en page, 3 jeux de contenus VPM 1 / VPM 2 / VPM 3).',
        'Agenda : numérotation d’origine incohérente (1, 2, 3, 4, 3, 5 ; deux « 4> » sur les VPM 1). Remplacée par la numérotation automatique : 1 à 6 (VPM 2), 1 à 7 (VPM 1 et 3).',
        'La règle « Ne pas analyser les problèmes lors de la VPM » existe sur les VPM 1 et 3 mais pas sur les VPM 2 : écart d’origine conservé (à valider par le propriétaire du document).',
        'Visas repris tels quels du document d’origine (date de visa = date d’effet, à confirmer).',
      ],
    },
  },
  visas: [],
  body: [repeat],
};
