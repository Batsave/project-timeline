/**
 * Migration de l'historique agents quand le CALCUL des tokens change (AGENT_CALC_VERSION)
 * ou quand l'extension change de version (tables de prix mises à jour).
 * PURE : reçoit les événements décodés + les sessions déjà re-parsées, rend la log compactée.
 *
 * Par session d'agent (agent + sessionUuid) :
 *  - fichier source encore présent -> re-parse complet : chiffres EXACTS, prix courants ;
 *  - fichier disparu (Claude Code purge ses transcripts après ~30 jours) -> on corrige
 *    les événements stockés eux-mêmes (`upgradeStoredTurns`) puis on re-calcule le coût.
 * Les autres événements sont gardés tels quels. Pour chaque session on ne garde qu'UN
 * agent_session (le tracker live en ré-émet une version à chaque flush).
 */
import type {
  AgentKind,
  AgentSessionPayload,
  AgentTokens,
  AgentTurnPayload,
  TrackEvent,
} from './types.js';
import { AGENT_CALC_VERSION } from './types.js';
import { agentEventId, claudeTurnEventId } from './jsonl.js';
import { addTokens, estimateCost, ZERO_TOKENS, type PricingTable } from './pricing.js';

export interface ReparsedTurn {
  byteOffset: number;
  messageId?: string;
  ts: string;
  model: string;
  /** DELTA du tour (les cumuls Codex sont déjà convertis par l'appelant). */
  tokens: AgentTokens;
}

export interface ReparsedSession {
  turns: ReparsedTurn[];
  nextOffset: number;
  unparsedLines: number;
}

export interface MigrationInput {
  /** événements décodés (déjà dédupliqués par eventId). */
  events: TrackEvent[];
  pricing: Record<AgentKind, PricingTable | undefined>;
  /** sessions dont le fichier source existe encore, clé `sessionKey(agent, uuid)`. */
  reparsed: Map<string, ReparsedSession>;
}

export interface MigrationResult {
  events: TrackEvent[];
  /** sessions re-parsées depuis leur source. */
  reparsedSessions: number;
  /** sessions orphelines corrigées depuis les événements stockés. */
  upgradedSessions: number;
  /** tours supprimés (doublons Claude) + versions d'agent_session superflues. */
  droppedEvents: number;
}

export function sessionKey(agent: AgentKind, uuid: string): string {
  return `${agent}:${uuid}`;
}

function isAgentEvent(e: TrackEvent): boolean {
  return e.type === 'agent_turn' || e.type === 'agent_session';
}

function calcVersionOf(e: TrackEvent): number {
  return (e.payload as { calcVersion?: number })?.calcVersion ?? 1;
}

/** true si au moins un événement agent a été calculé par une ancienne version. */
export function hasStaleAgentEvents(events: TrackEvent[]): boolean {
  return events.some((e) => isAgentEvent(e) && calcVersionOf(e) < AGENT_CALC_VERSION);
}

/** Sessions d'agent présentes dans la log (pour savoir quoi re-parser). */
export function agentSessionsIn(events: TrackEvent[]): Array<{ agent: AgentKind; uuid: string }> {
  const seen = new Map<string, { agent: AgentKind; uuid: string }>();
  for (const e of events) {
    if (!isAgentEvent(e)) continue;
    const p = e.payload as AgentTurnPayload;
    const k = sessionKey(p.agent, p.sessionUuid);
    if (!seen.has(k)) seen.set(k, { agent: p.agent, uuid: p.sessionUuid });
  }
  return [...seen.values()];
}

/** Dernier segment numérique d'un eventId `<agent>:<uuid>:<byteOffset>`. */
function offsetOf(e: TrackEvent): number {
  const n = Number(e.eventId.split(':').pop());
  return Number.isFinite(n) ? n : 0;
}

function tokensOf(p: AgentTokens): AgentTokens {
  return {
    input: p.input ?? 0,
    output: p.output ?? 0,
    cacheCreate: p.cacheCreate ?? 0,
    cacheCreate1h: p.cacheCreate1h ?? 0,
    cacheRead: p.cacheRead ?? 0,
    reasoning: p.reasoning ?? 0,
  };
}

/**
 * Corrige des agent_turn calculés en v1, sans fichier source :
 *  - Claude : une réponse API = plusieurs lignes au même usage. Elles étaient comptées
 *    chacune -> on retire les tours CONSÉCUTIFS (ordre du fichier) aux tokens identiques.
 *    Validé contre un re-parse exact : +0,1 % d'écart. Le détail 5 min / 1 h du cache
 *    n'était pas stocké -> tout est supposé en 1 h (99,5 % mesuré sous Claude Code).
 *  - Codex : input_tokens incluait le cache -> on le retire.
 * Les tours déjà en version courante sont rendus tels quels.
 */
export function upgradeStoredTurns(agent: AgentKind, turns: TrackEvent[]): TrackEvent[] {
  const current = turns.filter((e) => calcVersionOf(e) >= AGENT_CALC_VERSION);
  const stale = turns
    .filter((e) => calcVersionOf(e) < AGENT_CALC_VERSION)
    .sort((a, b) => offsetOf(a) - offsetOf(b));

  const upgraded: TrackEvent[] = [];
  let prevKey = '';
  for (const e of stale) {
    const t = tokensOf(e.payload as AgentTurnPayload);
    if (agent === 'claude') {
      const key = `${t.input}|${t.output}|${t.cacheCreate}|${t.cacheRead}`;
      if (key === prevKey) continue;
      prevKey = key;
      t.cacheCreate1h = t.cacheCreate;
    } else {
      t.input = Math.max(0, t.input - t.cacheRead - t.cacheCreate);
    }
    upgraded.push({
      ...e,
      payload: { ...(e.payload as AgentTurnPayload), ...t, calcVersion: AGENT_CALC_VERSION },
    });
  }
  return [...upgraded, ...current];
}

function withCost(e: TrackEvent, table: PricingTable | undefined): TrackEvent {
  const p = e.payload as AgentTurnPayload;
  const cost = estimateCost(p.model, tokensOf(p), table);
  return {
    ...e,
    payload: { ...p, costEstimateUSD: cost.costEstimateUSD, pricingVersion: cost.pricingVersion },
  };
}

function sumCost(turns: TrackEvent[]): number | null {
  let total: number | null = null;
  for (const e of turns) {
    const c = (e.payload as AgentTurnPayload).costEstimateUSD;
    if (c != null) total = (total ?? 0) + c;
  }
  return total == null ? null : Math.round(total * 10_000) / 10_000;
}

export function migrateAgentHistory(input: MigrationInput): MigrationResult {
  const others: TrackEvent[] = [];
  const groups = new Map<string, { agent: AgentKind; uuid: string; events: TrackEvent[] }>();
  for (const e of input.events) {
    if (!isAgentEvent(e)) {
      others.push(e);
      continue;
    }
    const p = e.payload as AgentTurnPayload;
    const k = sessionKey(p.agent, p.sessionUuid);
    let g = groups.get(k);
    if (!g) {
      g = { agent: p.agent, uuid: p.sessionUuid, events: [] };
      groups.set(k, g);
    }
    g.events.push(e);
  }

  const out = [...others];
  let reparsedSessions = 0;
  let upgradedSessions = 0;
  let agentEventsOut = 0;
  const agentEventsIn = input.events.length - others.length;

  for (const [k, g] of groups) {
    const table = input.pricing[g.agent];
    const storedTurns = g.events.filter((e) => e.type === 'agent_turn');
    const storedSessions = g.events.filter((e) => e.type === 'agent_session');
    const latestSession = storedSessions.reduce<TrackEvent | undefined>(
      (best, e) => (!best || offsetOf(e) > offsetOf(best) ? e : best),
      undefined,
    );
    const ref = storedTurns[0] ?? latestSession!;
    const meta = latestSession?.payload as AgentSessionPayload | undefined;

    let turns: TrackEvent[];
    let sessionEventId: string;
    let unparsedLines: number;
    const source = input.reparsed.get(k);
    if (source) {
      reparsedSessions++;
      turns = source.turns.map((t) => {
        const cost = estimateCost(t.model, t.tokens, table);
        return {
          eventId:
            g.agent === 'claude'
              ? claudeTurnEventId(g.uuid, t.messageId, t.byteOffset)
              : agentEventId(g.agent, g.uuid, t.byteOffset),
          ts: t.ts,
          project: ref.project,
          branch: ref.branch,
          sessionId: ref.sessionId,
          type: 'agent_turn' as const,
          payload: {
            agent: g.agent,
            sessionUuid: g.uuid,
            model: t.model,
            ...t.tokens,
            costEstimateUSD: cost.costEstimateUSD,
            pricingVersion: cost.pricingVersion,
            calcVersion: AGENT_CALC_VERSION,
          } satisfies AgentTurnPayload,
        };
      });
      sessionEventId = agentEventId(g.agent, g.uuid, source.nextOffset);
      unparsedLines = source.unparsedLines;
    } else {
      upgradedSessions++;
      turns = upgradeStoredTurns(g.agent, storedTurns).map((e) => withCost(e, table));
      sessionEventId = latestSession?.eventId ?? agentEventId(g.agent, g.uuid, 0);
      unparsedLines = meta?.unparsedLines ?? 0;
    }
    turns.sort((a, b) => a.ts.localeCompare(b.ts));
    out.push(...turns);
    agentEventsOut += turns.length;

    if (turns.length === 0 && !latestSession) continue;
    const tokens = turns.reduce(
      (acc, e) => addTokens(acc, tokensOf(e.payload as AgentTurnPayload)),
      { ...ZERO_TOKENS },
    );
    const last = turns[turns.length - 1];
    const session: AgentSessionPayload = {
      agent: g.agent,
      sessionUuid: g.uuid,
      model: (last?.payload as AgentTurnPayload | undefined)?.model ?? meta?.model ?? 'unknown',
      cwd: meta?.cwd ?? '',
      startedAt: turns[0]?.ts ?? meta?.startedAt ?? ref.ts,
      endedAt: last?.ts ?? meta?.endedAt ?? ref.ts,
      turns: turns.length,
      ...tokens,
      costEstimateUSD: sumCost(turns),
      pricingVersion: table?.version ?? null,
      unparsedLines,
      calcVersion: AGENT_CALC_VERSION,
    };
    out.push({
      eventId: sessionEventId,
      ts: session.endedAt,
      project: ref.project,
      branch: ref.branch,
      sessionId: ref.sessionId,
      type: 'agent_session',
      payload: session,
    });
    agentEventsOut++;
  }

  return {
    events: out,
    reparsedSessions,
    upgradedSessions,
    droppedEvents: Math.max(0, agentEventsIn - agentEventsOut),
  };
}
