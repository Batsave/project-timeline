/**
 * Parseur incrémental d'un fichier de session Codex CLI (JSONL).
 * Pur : pas d'accès disque, pas de `vscode`.
 *
 * Format observé (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) :
 *   1re ligne : { "type": "session_meta", "payload": { "cwd": "C:\\projects\\foo",
 *                  "model_provider": "openai", "model": "gpt-5-codex", "cli_version": "..." } }
 *   lignes de comptage : un objet contenant, sous une clé variable selon la version,
 *     { input_tokens, cached_input_tokens, cache_write_input_tokens,
 *       output_tokens, reasoning_output_tokens, total_tokens }
 *     clés possibles : token_usage | total_token_usage | last_token_usage | info.total_token_usage
 *     `last_*` = delta du tour ; `total_*` = cumul de la session.
 *   ATTENTION (vérifié : total_tokens = input_tokens + output_tokens) :
 *     - input_tokens INCLUT cached_input_tokens -> on les retire pour ne pas facturer deux fois ;
 *     - output_tokens INCLUT reasoning_output_tokens -> reasoning reste informatif.
 */
import type { AgentTokens } from './types.js';

export interface CodexMeta {
  cwd?: string;
  model?: string;
  cliVersion?: string;
}

export interface CodexTurn {
  byteOffset: number;
  ts: string;
  /** true si la valeur lue est un cumul de session, false si c'est un delta de tour. */
  isCumulative: boolean;
  tokens: AgentTokens;
}

export interface CodexParseResult {
  meta: CodexMeta | undefined; // présent si la ligne session_meta a été vue dans ce lot
  turns: CodexTurn[];
  nextOffset: number;
  unparsedLines: number;
}

export function parseCodexIncremental(
  content: string,
  startOffset: number,
  fallbackTs: string,
): CodexParseResult {
  const turns: CodexTurn[] = [];
  let unparsedLines = 0;
  let meta: CodexMeta | undefined;

  const buf = Buffer.from(content, 'utf8');
  const start = Math.min(Math.max(0, startOffset), buf.length);
  let lineStart = start;
  let nextOffset = start;

  for (let i = start; i < buf.length; i++) {
    if (buf[i] !== 0x0a) {
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

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      unparsedLines++;
      continue;
    }

    if (obj?.type === 'session_meta' || obj?.payload?.cwd) {
      meta = {
        cwd: obj?.payload?.cwd,
        model: obj?.payload?.model,
        cliVersion: obj?.payload?.cli_version,
      };
      continue;
    }

    const found = findUsage(obj);
    if (!found) {
      continue; // ligne valide sans comptage : normale, on l'ignore
    }
    const ts: string = typeof obj?.timestamp === 'string' ? obj.timestamp : fallbackTs;
    turns.push({ byteOffset, ts, isCumulative: found.isCumulative, tokens: found.tokens });
  }

  return { meta, turns, nextOffset, unparsedLines };
}

interface Usage {
  isCumulative: boolean;
  tokens: AgentTokens;
}

/** Essaie les emplacements connus, du plus spécifique au plus général. */
function findUsage(obj: any): Usage | null {
  const candidates: Array<{ node: any; cumulative: boolean }> = [
    { node: deep(obj, ['payload', 'info', 'total_token_usage']), cumulative: true },
    { node: deep(obj, ['info', 'total_token_usage']), cumulative: true },
    { node: deep(obj, ['payload', 'total_token_usage']), cumulative: true },
    { node: deep(obj, ['total_token_usage']), cumulative: true },
    { node: deep(obj, ['payload', 'info', 'last_token_usage']), cumulative: false },
    { node: deep(obj, ['info', 'last_token_usage']), cumulative: false },
    { node: deep(obj, ['payload', 'last_token_usage']), cumulative: false },
    { node: deep(obj, ['last_token_usage']), cumulative: false },
    { node: deep(obj, ['payload', 'token_usage']), cumulative: false },
    { node: deep(obj, ['token_usage']), cumulative: false },
  ];
  for (const c of candidates) {
    if (c.node && typeof c.node === 'object' && hasAnyTokenKey(c.node)) {
      return { isCumulative: c.cumulative, tokens: readTokens(c.node) };
    }
  }
  return null;
}

function deep(obj: any, path: string[]): any {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[k];
  }
  return cur;
}

function hasAnyTokenKey(n: any): boolean {
  return (
    'input_tokens' in n ||
    'output_tokens' in n ||
    'total_tokens' in n ||
    'cached_input_tokens' in n ||
    'reasoning_output_tokens' in n
  );
}

function readTokens(n: any): AgentTokens {
  const cacheRead = num(n.cached_input_tokens ?? n.cache_read_input_tokens);
  const cacheCreate = num(n.cache_write_input_tokens ?? n.cache_creation_input_tokens);
  return {
    input: Math.max(0, num(n.input_tokens) - cacheRead - cacheCreate),
    output: num(n.output_tokens),
    cacheCreate,
    cacheRead,
    reasoning: num(n.reasoning_output_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
