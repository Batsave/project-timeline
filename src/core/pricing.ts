/**
 * Estimation de coût. Les tables de prix sont dans pricing/*.json, versionnées
 * (version / date / source) pour qu'on sache toujours d'où vient un chiffre.
 * Le coût reste une ESTIMATION.
 */
import type { AgentTokens } from './types.js';

export interface ModelPrice {
  /** USD par 1M tokens d'entrée. */
  in: number;
  /** USD par 1M tokens de sortie. */
  out: number;
  /** Multiplicateur appliqué au prix `in` pour l'écriture de cache 5 min. Défaut 1.25. */
  cacheWriteMult?: number;
  /** Multiplicateur appliqué au prix `in` pour l'écriture de cache 1 h. Défaut 2. */
  cacheWrite1hMult?: number;
  /** Multiplicateur appliqué au prix `in` pour la lecture de cache. Défaut 0.1. */
  cacheReadMult?: number;
}

export interface PricingTable {
  version: string;
  date?: string;
  source?: string;
  unit?: string;
  models: Record<string, ModelPrice>;
}

export interface CostResult {
  costEstimateUSD: number | null;
  pricingVersion: string | null;
  /** Rempli quand le modèle est inconnu de la table. */
  warning?: string;
}

const DEFAULT_CACHE_WRITE_MULT = 1.25;
const DEFAULT_CACHE_WRITE_1H_MULT = 2;
const DEFAULT_CACHE_READ_MULT = 0.1;

/**
 * Calcule le coût estimé d'un lot de tokens pour un modèle donné.
 * Modèle absent de la table -> costEstimateUSD null + warning.
 */
export function estimateCost(
  model: string,
  tokens: AgentTokens,
  table: PricingTable | undefined,
): CostResult {
  if (!table) {
    return { costEstimateUSD: null, pricingVersion: null, warning: 'no pricing table loaded' };
  }
  const price = table.models[model] ?? table.models[normalizeModel(model)];
  if (!price) {
    return {
      costEstimateUSD: null,
      pricingVersion: table.version,
      warning: `unknown model "${model}"`,
    };
  }
  const cacheWriteMult = price.cacheWriteMult ?? DEFAULT_CACHE_WRITE_MULT;
  const cacheWrite1hMult = price.cacheWrite1hMult ?? DEFAULT_CACHE_WRITE_1H_MULT;
  const cacheReadMult = price.cacheReadMult ?? DEFAULT_CACHE_READ_MULT;
  // `output` inclut déjà `reasoning` (thinking) : on ne le refacture pas.
  const cache1h = Math.min(tokens.cacheCreate1h ?? 0, tokens.cacheCreate);
  const cache5m = tokens.cacheCreate - cache1h;
  const usd =
    (tokens.input * price.in +
      tokens.output * price.out +
      cache5m * price.in * cacheWriteMult +
      cache1h * price.in * cacheWrite1hMult +
      tokens.cacheRead * price.in * cacheReadMult) /
    1_000_000;
  return { costEstimateUSD: round4(usd), pricingVersion: table.version };
}

/** Tolérance sur les variantes de nom (`us.anthropic.claude-...`, suffixes de date, `[1m]`). */
function normalizeModel(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(us|eu|apac)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function addTokens(a: AgentTokens, b: AgentTokens): AgentTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheCreate1h: (a.cacheCreate1h ?? 0) + (b.cacheCreate1h ?? 0),
    cacheRead: a.cacheRead + b.cacheRead,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

/**
 * Delta entre deux snapshots CUMULATIFS. Un champ qui recule (nouvelle session dans
 * le même fichier, remise à zéro) est ramené à 0 plutôt que négatif.
 */
export function diffTokens(current: AgentTokens, previous: AgentTokens): AgentTokens {
  const d = (a: number, b: number) => Math.max(0, a - b);
  return {
    input: d(current.input, previous.input),
    output: d(current.output, previous.output),
    cacheCreate: d(current.cacheCreate, previous.cacheCreate),
    cacheCreate1h: d(current.cacheCreate1h ?? 0, previous.cacheCreate1h ?? 0),
    cacheRead: d(current.cacheRead, previous.cacheRead),
    reasoning: d(current.reasoning ?? 0, previous.reasoning ?? 0),
  };
}

export function nonZero(t: AgentTokens): boolean {
  return (
    t.input > 0 ||
    t.output > 0 ||
    t.cacheCreate > 0 ||
    t.cacheRead > 0 ||
    (t.reasoning ?? 0) > 0
  );
}

export const ZERO_TOKENS: AgentTokens = {
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheCreate1h: 0,
  cacheRead: 0,
  reasoning: 0,
};
