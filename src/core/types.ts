/**
 * Modèle d'événement unique. Une ligne JSONL par événement, jamais de mutation.
 * Tout indicateur est calculé par agrégation a posteriori (voir rollup.ts).
 *
 * `eventId` : identifiant stable utilisé pour la déduplication au scan.
 *   - Événements relus depuis une source persistante (agents, commits) : id DÉTERMINISTE
 *     dérivé de la source, pour qu'un re-parse après crash ne double-compte pas.
 *   - Événements générés une seule fois en live : id de séquence `<type>:<sessionId>:<seq>`.
 */

export type EventType =
  | 'session'
  | 'commit'
  | 'test_run'
  | 'task_run'
  | 'debug_session'
  | 'agent_session'
  | 'agent_turn'
  | 'file_edit'
  | 'file_fs'
  | 'diagnostics';

export interface TrackEvent {
  eventId: string;
  ts: string; // ISO 8601
  project: string;
  branch?: string;
  sessionId: string;
  type: EventType;
  payload: unknown;
}

/**
 * Dimensions temporelles d'une session de travail.
 * ATTENTION : ce sont des ensembles temporels qui SE CHEVAUCHENT.
 * `durationMs` n'est PAS la somme des autres.
 */
export interface SessionPayload {
  durationMs: number;
  focusMs: number; // ⊆ duration — fenêtre VS Code au premier plan
  interactionMs: number; // ⊆ duration — interaction éditeur récente
  agentPresentMs: number; // ⊆ duration — un agent du projet était actif
  agentOnlyMs: number; // agentPresent \ interaction
  focusOnlyMs: number; // focus \ interaction \ agentPresent
  idleMs: number; // duration \ (interaction ∪ agentPresent)
  /** true = session ESTIMÉE par backfill (historique), pas mesurée en direct. */
  estimated?: boolean;
}

export interface CommitPayload {
  hash: string;
  message: string;
  author: string;
  branch: string;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

export interface TestRunPayload {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  source: 'testApi' | 'terminal';
  command?: string;
  exitCode?: number;
}

export interface TaskRunPayload {
  name: string;
  ok: boolean;
  durationMs: number;
}

export interface DebugSessionPayload {
  name: string;
  durationMs: number;
}

export type FileEditPayload = {
  file: string; // relatif au workspace
  language: string;
  linesAdded: number;
  linesRemoved: number;
};

export type FileFsPayload = {
  file: string; // relatif au workspace
  language: string;
  kind: 'create' | 'delete' | 'change';
};

export interface DiagnosticsPayload {
  errors: number;
  warnings: number;
  byLanguage?: Record<string, { errors: number; warnings: number }>;
}

export type AgentKind = 'claude' | 'codex';

/**
 * Version du CALCUL des tokens agents (parseurs + règles de coût). À incrémenter quand
 * un correctif change les chiffres : les événements plus anciens sont alors migrés
 * (cf. core/migrate.ts). 1 = avant dédup Claude / cache 1 h / input Codex hors cache.
 */
export const AGENT_CALC_VERSION = 2;

export interface AgentTokens {
  input: number;
  output: number;
  /** écriture de cache totale (5 min + 1 h). */
  cacheCreate: number;
  /** part de `cacheCreate` écrite dans le cache 1 h (facturée plus cher). ⊆ cacheCreate. */
  cacheCreate1h?: number;
  cacheRead: number;
  /** informatif : déjà inclus dans `output`, jamais facturé en plus. */
  reasoning?: number;
}

export interface AgentTurnPayload extends AgentTokens {
  agent: AgentKind;
  sessionUuid: string;
  model: string;
  costEstimateUSD: number | null;
  pricingVersion: string | null;
  /** absent = 1 (événement antérieur au versionnage du calcul). */
  calcVersion?: number;
}

export interface AgentSessionPayload extends AgentTokens {
  agent: AgentKind;
  sessionUuid: string;
  model: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  costEstimateUSD: number | null;
  pricingVersion: string | null;
  unparsedLines: number;
  /** absent = 1 (événement antérieur au versionnage du calcul). */
  calcVersion?: number;
}
