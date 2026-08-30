/**
 * Reconstruction d'événements à partir de l'HISTORIQUE existant, à la première
 * ouverture d'un projet (pour ne pas démarrer avec un tableau de bord vide).
 * PURE : reçoit des données déjà lues, produit des TrackEvent.
 *
 * Ce qu'on peut reconstruire honnêtement :
 *  - agent_turn / agent_session : depuis tout l'historique des sessions Claude/Codex
 *  - commit                     : depuis `git log` complet (avec --numstat)
 *  - session (temps de travail)  : ESTIMÉ par jour depuis les commits + tours d'agent
 *    -> marqué `estimated: true` dans le payload, jamais confondu avec du mesuré.
 *
 * Ce qu'on ne reconstruit PAS : file_edit fin, diagnostics, tasks/debug, focus.
 */
import type { TrackEvent, SessionPayload } from './types.js';

export interface BackfillCommit {
  hash: string;
  message: string;
  author: string;
  branch: string;
  isoDate: string;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

export interface BackfillInput {
  project: string;
  /** événements agent déjà produits par les parseurs (mêmes eventId déterministes). */
  agentEvents: TrackEvent[];
  commits: BackfillCommit[];
  /** borne : on n'estime pas de temps après cette date (les vraies mesures prennent le relais). */
  nowTs: number;
}

const DAY_MS = 24 * 3600_000;

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Produit la liste complète d'événements de backfill.
 * Les `session` estimées portent `estimated: true` et un `sessionId` préfixé `bf_`.
 */
export function buildBackfillEvents(input: BackfillInput): TrackEvent[] {
  const out: TrackEvent[] = [];

  // 1. commits
  for (const c of input.commits) {
    out.push({
      eventId: `commit:${c.hash}`,
      ts: c.isoDate,
      project: input.project,
      branch: c.branch,
      sessionId: 'bf_git',
      type: 'commit',
      payload: {
        hash: c.hash,
        message: c.message.slice(0, 500),
        author: c.author,
        branch: c.branch,
        insertions: c.insertions,
        deletions: c.deletions,
        filesChanged: c.filesChanged,
      },
    });
  }

  // 2. événements agents (déjà formés par les parseurs, eventId déterministes)
  for (const e of input.agentEvents) {
    out.push(e);
  }

  // 3. temps de travail ESTIMÉ par jour
  //    signal par jour = ensemble des timestamps (commits + agent_turn)
  const byDay = new Map<string, number[]>();
  const addTs = (iso: string) => {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts) || ts > input.nowTs) return;
    const key = localDateKey(ts);
    let list = byDay.get(key);
    if (!list) {
      list = [];
      byDay.set(key, list);
    }
    list.push(ts);
  };
  for (const c of input.commits) addTs(c.isoDate);
  for (const e of input.agentEvents) {
    if (e.type === 'agent_turn') addTs(e.ts);
  }

  for (const [day, tsList] of byDay) {
    if (tsList.length === 0) continue;
    tsList.sort((a, b) => a - b);
    const first = tsList[0];
    const last = tsList[tsList.length - 1];
    // amplitude + marge de 45 min (avant le 1er signal), bornée à 12 h,
    // plancher 20 min si signal unique.
    let durationMs = tsList.length === 1 ? 20 * 60_000 : last - first + 45 * 60_000;
    durationMs = Math.min(durationMs, 12 * 3600_000);

    // ventilation grossière : si des tours d'agent existent ce jour-là, on met
    // agentOnly ~ 40 % du temps, sinon 0.
    const hasAgent = input.agentEvents.some(
      (e) => e.type === 'agent_turn' && localDateKey(Date.parse(e.ts)) === day,
    );
    const agentOnlyMs = hasAgent ? Math.round(durationMs * 0.4) : 0;
    const interactionMs = durationMs - agentOnlyMs;

    const payload: SessionPayload & { estimated: true } = {
      durationMs,
      focusMs: durationMs,
      interactionMs,
      agentPresentMs: agentOnlyMs,
      agentOnlyMs,
      focusOnlyMs: 0,
      idleMs: 0,
      estimated: true,
    };
    out.push({
      eventId: `session:bf_${day}:0`,
      ts: new Date(last).toISOString(),
      project: input.project,
      sessionId: `bf_${day}`,
      type: 'session',
      payload,
    });
  }

  return out;
}

/** vrai si aucune donnée mesurée n'existe encore pour ce projet (hors backfill). */
export function needsBackfill(events: TrackEvent[], project: string): boolean {
  return !events.some(
    (e) =>
      e.project === project &&
      !e.sessionId.startsWith('bf_') &&
      (e.type === 'session' || e.type === 'agent_turn'),
  );
}

export { DAY_MS };
