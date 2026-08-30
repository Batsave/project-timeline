/**
 * Parseur incrémental d'un fichier de session Claude Code (JSONL).
 * Pur : pas d'accès disque, pas de `vscode`. Le lecteur passe le contenu + l'offset.
 *
 * Format observé sur cette machine (b--quests/*.jsonl) :
 *   { "type": "assistant",
 *     "message": { "model": "claude-...", "usage": {
 *        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
 *        "output_tokens", "output_tokens_details": { "thinking_tokens" } } },
 *     "timestamp": "2026-08-30T..." }
 */
import type { AgentTokens } from './types.js';

export interface ClaudeTurn {
  /** offset (octets) du début de la ligne — sert d'eventId déterministe. */
  byteOffset: number;
  ts: string;
  model: string;
  tokens: AgentTokens;
}

export interface ClaudeParseResult {
  turns: ClaudeTurn[];
  /** nouvel offset : premier octet non encore traité (début d'une ligne éventuellement incomplète). */
  nextOffset: number;
  unparsedLines: number;
}

/**
 * @param content     contenu texte du fichier (UTF-8)
 * @param startOffset  offset en octets déjà traité (0 au premier passage)
 * @param fallbackTs   timestamp de repli si une ligne n'a pas de champ `timestamp`
 */
export function parseClaudeIncremental(
  content: string,
  startOffset: number,
  fallbackTs: string,
): ClaudeParseResult {
  const turns: ClaudeTurn[] = [];
  let unparsedLines = 0;

  const buf = Buffer.from(content, 'utf8');
  const start = Math.min(Math.max(0, startOffset), buf.length);
  let lineStart = start;
  let nextOffset = start;

  for (let i = start; i < buf.length; i++) {
    if (buf[i] !== 0x0a /* \n */) {
      continue;
    }
    const rawLine = buf.subarray(lineStart, i).toString('utf8').replace(/\r$/, '');
    const byteOffset = lineStart;
    nextOffset = i + 1;
    lineStart = nextOffset;

    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const turn = tryParseLine(trimmed, byteOffset, fallbackTs);
    if (turn === 'skip') {
      continue;
    }
    if (turn === null) {
      unparsedLines++;
      continue;
    }
    turns.push(turn);
  }

  return { turns, nextOffset, unparsedLines };
}

/** 'skip' = ligne valide mais sans usage exploitable ; null = ligne illisible. */
function tryParseLine(
  line: string,
  byteOffset: number,
  fallbackTs: string,
): ClaudeTurn | 'skip' | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = obj?.message?.usage ?? obj?.usage;
  if (!usage || typeof usage !== 'object') {
    return 'skip';
  }
  const model: string = obj?.message?.model ?? obj?.model ?? 'unknown';
  const ts: string = typeof obj?.timestamp === 'string' ? obj.timestamp : fallbackTs;
  const tokens: AgentTokens = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    reasoning: num(usage?.output_tokens_details?.thinking_tokens),
  };
  if (
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.cacheCreate === 0 &&
    tokens.cacheRead === 0
  ) {
    return 'skip';
  }
  return { byteOffset, ts, model, tokens };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
