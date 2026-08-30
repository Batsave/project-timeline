/**
 * Agrégation des événements en indicateurs. PURE.
 * Entrée : liste d'événements déjà dédupliquée (decodeEvents).
 * Sortie : un Rollup par (projet, période).
 */
import type {
  AgentSessionPayload,
  CommitPayload,
  DiagnosticsPayload,
  FileEditPayload,
  FileFsPayload,
  SessionPayload,
  TestRunPayload,
  TrackEvent,
} from './types.js';

export type Period = 'day' | 'week' | 'month' | 'all';

export interface TimeRollup {
  durationMs: number;
  focusMs: number;
  interactionMs: number;
  agentPresentMs: number;
  agentOnlyMs: number;
  focusOnlyMs: number;
  idleMs: number;
  sessions: number;
  longestSessionMs: number;
  medianSessionMs: number;
  /** ms provenant de sessions ESTIMÉES (backfill) — sous-ensemble de durationMs. */
  estimatedMs: number;
}

export interface ModelRollup {
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  reasoning: number;
  costEstimateUSD: number | null;
}

export interface AgentRollup {
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  reasoning: number;
  costEstimateUSD: number | null;
  pricingVersions: string[];
  unparsedLines: number;
  /** ventilation par modèle, du plus coûteux (ou plus gros) au plus petit. */
  byModel: ModelRollup[];
  /** part de tokens d'entrée servie par le cache : cacheRead / (input + cacheRead + cacheCreate). */
  cacheHitRatio: number;
  /** tokens totaux (in + out + cacheCreate + cacheRead). */
  totalTokens: number;
}

export interface Rollup {
  project: string;
  period: Period;
  since: string;
  time: TimeRollup;
  editor: {
    linesAdded: number;
    linesRemoved: number;
    filesEditedInEditor: number;
    fsCreate: number;
    fsDelete: number;
    fsChange: number;
    /** poids par langage (lignes ajoutées+supprimées), trié décroissant. */
    byLanguage: Array<{ language: string; lines: number; pct: number }>;
    topFiles: Array<{ file: string; activeMs: number; linesAdded: number; linesRemoved: number }>;
  };
  agents: Record<string, AgentRollup>; // clé: "claude" | "codex"
  quality: {
    lastErrors: number;
    lastWarnings: number;
    firstErrors: number | null;
    firstWarnings: number | null;
  };
  git: {
    commits: number;
    insertions: number;
    deletions: number;
  };
  counts: {
    testRuns: number;
    testsPassed: number;
    testsFailed: number;
    taskRuns: number;
    debugSessions: number;
  };
  /** minutes actives par heure de la journée (0..23). */
  heatmapByHour: number[];
}

const PERIOD_MS: Record<Exclude<Period, 'all'>, number> = {
  day: 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  month: 30 * 24 * 3600_000,
};

export function computeRollup(
  events: TrackEvent[],
  project: string,
  period: Period,
  now: number,
): Rollup {
  const since = period === 'all' ? 0 : now - PERIOD_MS[period];
  const inScope = events.filter(
    (e) => e.project === project && Date.parse(e.ts) >= since,
  );

  const r = emptyRollup(project, period, since);
  const sessionDurations: number[] = [];
  const topFilesMap = new Map<
    string,
    { activeMs: number; linesAdded: number; linesRemoved: number }
  >();
  let firstDiag: DiagnosticsPayload | null = null;
  let lastDiag: DiagnosticsPayload | null = null;
  const agentSessionsSeen = new Set<string>();
  const modelMaps: Record<string, Map<string, ModelRollup>> = {};
  const langLines = new Map<string, number>();

  for (const e of inScope) {
    const hour = new Date(e.ts).getHours();
    switch (e.type) {
      case 'session': {
        const p = e.payload as SessionPayload;
        addTime(r.time, p);
        sessionDurations.push(p.durationMs);
        r.time.sessions++;
        if (p.estimated) r.time.estimatedMs += p.durationMs;
        r.heatmapByHour[hour] += p.durationMs / 60_000;
        break;
      }
      case 'file_edit': {
        const p = e.payload as FileEditPayload;
        r.editor.linesAdded += p.linesAdded;
        r.editor.linesRemoved += p.linesRemoved;
        const key = p.file;
        const tf = topFilesMap.get(key) ?? { activeMs: 0, linesAdded: 0, linesRemoved: 0 };
        tf.linesAdded += p.linesAdded;
        tf.linesRemoved += p.linesRemoved;
        topFilesMap.set(key, tf);
        const lang = p.language || 'autre';
        langLines.set(lang, (langLines.get(lang) ?? 0) + p.linesAdded + p.linesRemoved);
        break;
      }
      case 'file_fs': {
        const p = e.payload as FileFsPayload;
        if (p.kind === 'create') r.editor.fsCreate++;
        else if (p.kind === 'delete') r.editor.fsDelete++;
        else r.editor.fsChange++;
        break;
      }
      case 'agent_turn': {
        const p = e.payload as import('./types.js').AgentTurnPayload;
        const a = ensureAgent(r.agents, p.agent);
        a.turns++;
        a.input += p.input;
        a.output += p.output;
        a.cacheCreate += p.cacheCreate;
        a.cacheRead += p.cacheRead;
        a.reasoning += p.reasoning ?? 0;
        if (p.costEstimateUSD != null) {
          a.costEstimateUSD = (a.costEstimateUSD ?? 0) + p.costEstimateUSD;
        }
        const m = ensureModel(modelMaps, p.agent, p.model || 'unknown');
        m.turns++;
        m.input += p.input;
        m.output += p.output;
        m.cacheCreate += p.cacheCreate;
        m.cacheRead += p.cacheRead;
        m.reasoning += p.reasoning ?? 0;
        if (p.costEstimateUSD != null) {
          m.costEstimateUSD = (m.costEstimateUSD ?? 0) + p.costEstimateUSD;
        }
        break;
      }
      case 'agent_session': {
        // Le coût et les tokens viennent des agent_turn (deltas, toujours additifs).
        // agent_session ne sert qu'au comptage de sessions + méta.
        const p = e.payload as AgentSessionPayload;
        const a = ensureAgent(r.agents, p.agent);
        if (!agentSessionsSeen.has(p.sessionUuid)) {
          agentSessionsSeen.add(p.sessionUuid);
          a.sessions++;
        }
        a.unparsedLines = Math.max(a.unparsedLines, p.unparsedLines);
        if (p.pricingVersion && !a.pricingVersions.includes(p.pricingVersion)) {
          a.pricingVersions.push(p.pricingVersion);
        }
        break;
      }
      case 'commit': {
        const p = e.payload as CommitPayload;
        r.git.commits++;
        r.git.insertions += p.insertions;
        r.git.deletions += p.deletions;
        break;
      }
      case 'test_run': {
        const p = e.payload as TestRunPayload;
        r.counts.testRuns++;
        r.counts.testsPassed += p.passed;
        r.counts.testsFailed += p.failed;
        break;
      }
      case 'task_run':
        r.counts.taskRuns++;
        break;
      case 'debug_session':
        r.counts.debugSessions++;
        break;
      case 'diagnostics': {
        const p = e.payload as DiagnosticsPayload;
        if (!firstDiag) firstDiag = p;
        lastDiag = p;
        break;
      }
    }
  }

  // top fichiers par temps actif : on n'a pas encore le temps par fichier (v1.5),
  // on classe donc par volume de lignes modifiées en attendant.
  r.editor.filesEditedInEditor = topFilesMap.size;
  r.editor.topFiles = [...topFilesMap.entries()]
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved))
    .slice(0, 20);

  const totalLangLines = [...langLines.values()].reduce((s, n) => s + n, 0);
  r.editor.byLanguage = [...langLines.entries()]
    .map(([language, lines]) => ({
      language,
      lines,
      pct: totalLangLines > 0 ? (lines / totalLangLines) * 100 : 0,
    }))
    .sort((a, b) => b.lines - a.lines);

  // finalisation des agents : ventilation par modèle + ratios
  for (const [name, a] of Object.entries(r.agents)) {
    const mm = modelMaps[name];
    a.byModel = mm
      ? [...mm.values()].sort(
          (x, y) =>
            (y.costEstimateUSD ?? 0) - (x.costEstimateUSD ?? 0) ||
            y.input + y.output + y.cacheCreate + y.cacheRead -
              (x.input + x.output + x.cacheCreate + x.cacheRead),
        )
      : [];
    a.totalTokens = a.input + a.output + a.cacheCreate + a.cacheRead;
    const inputSide = a.input + a.cacheRead + a.cacheCreate;
    a.cacheHitRatio = inputSide > 0 ? a.cacheRead / inputSide : 0;
  }

  r.time.longestSessionMs = sessionDurations.length ? Math.max(...sessionDurations) : 0;
  r.time.medianSessionMs = median(sessionDurations);

  if (firstDiag) {
    r.quality.firstErrors = (firstDiag as DiagnosticsPayload).errors;
    r.quality.firstWarnings = (firstDiag as DiagnosticsPayload).warnings;
  }
  if (lastDiag) {
    r.quality.lastErrors = (lastDiag as DiagnosticsPayload).errors;
    r.quality.lastWarnings = (lastDiag as DiagnosticsPayload).warnings;
  }

  return r;
}

function addTime(t: TimeRollup, p: SessionPayload): void {
  t.durationMs += p.durationMs;
  t.focusMs += p.focusMs;
  t.interactionMs += p.interactionMs;
  t.agentPresentMs += p.agentPresentMs;
  t.agentOnlyMs += p.agentOnlyMs;
  t.focusOnlyMs += p.focusOnlyMs;
  t.idleMs += p.idleMs;
}

function ensureAgent(map: Record<string, AgentRollup>, agent: string): AgentRollup {
  if (!map[agent]) {
    map[agent] = {
      sessions: 0,
      turns: 0,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      reasoning: 0,
      costEstimateUSD: null,
      pricingVersions: [],
      unparsedLines: 0,
      byModel: [],
      cacheHitRatio: 0,
      totalTokens: 0,
    };
  }
  return map[agent];
}

function ensureModel(
  maps: Record<string, Map<string, ModelRollup>>,
  agent: string,
  model: string,
): ModelRollup {
  const mm = (maps[agent] ??= new Map());
  let m = mm.get(model);
  if (!m) {
    m = {
      model,
      turns: 0,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      reasoning: 0,
      costEstimateUSD: null,
    };
    mm.set(model, m);
  }
  return m;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function emptyRollup(project: string, period: Period, since: number): Rollup {
  return {
    project,
    period,
    since: new Date(since).toISOString(),
    time: {
      durationMs: 0,
      focusMs: 0,
      interactionMs: 0,
      agentPresentMs: 0,
      agentOnlyMs: 0,
      focusOnlyMs: 0,
      idleMs: 0,
      sessions: 0,
      longestSessionMs: 0,
      medianSessionMs: 0,
      estimatedMs: 0,
    },
    editor: {
      linesAdded: 0,
      linesRemoved: 0,
      filesEditedInEditor: 0,
      fsCreate: 0,
      fsDelete: 0,
      fsChange: 0,
      byLanguage: [],
      topFiles: [],
    },
    agents: {},
    quality: { lastErrors: 0, lastWarnings: 0, firstErrors: null, firstWarnings: null },
    git: { commits: 0, insertions: 0, deletions: 0 },
    counts: {
      testRuns: 0,
      testsPassed: 0,
      testsFailed: 0,
      taskRuns: 0,
      debugSessions: 0,
    },
    heatmapByHour: new Array(24).fill(0),
  };
}
