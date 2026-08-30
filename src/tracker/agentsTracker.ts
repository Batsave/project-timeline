/**
 * Surveille les dossiers de sessions Claude Code + Codex CLI pour le projet courant.
 * Émet agent_turn (par ligne) + agent_session (cumul, ré-émis à chaque flush).
 * Expose `lastAgentWriteMs()` pour la règle `alive` d'ActivityTracker.
 *
 * Idempotence : eventId déterministe `<agent>:<uuid>:<byteOffset>`. offsets.json n'est
 * qu'un cache — un re-parse complet ne double-compte pas (dédup au rollup).
 */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Emitter } from '../emitter.js';
import type { Store } from '../store/store.js';
import { log } from '../store/store.js';
import { projectPathToClaudeSlug, isCwdUnder } from '../core/slug.js';
import { parseClaudeIncremental } from '../core/parse-claude.js';
import { parseCodexIncremental } from '../core/parse-codex.js';
import {
  estimateCost,
  addTokens,
  diffTokens,
  nonZero,
  ZERO_TOKENS,
  type PricingTable,
} from '../core/pricing.js';
import { agentEventId } from '../core/jsonl.js';
import type { AgentKind, AgentTokens } from '../core/types.js';

const POLL_MS = 5_000;

interface SessionAgg {
  agent: AgentKind;
  uuid: string;
  model: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  /** cumul des DELTAS crédités pour cette session. */
  tokens: AgentTokens;
  /** dernier snapshot cumulatif vu (sources Codex total_token_usage). */
  lastCumulative: AgentTokens;
  cost: number | null;
  pricingVersion: string | null;
  unparsedLines: number;
}

export class AgentsTracker {
  private offsets: Record<string, number> = {};
  private sessions = new Map<string, SessionAgg>();
  private lastWriteMs = 0;
  private timer?: NodeJS.Timeout;
  private claudePricing?: PricingTable;
  private codexPricing?: PricingTable;
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(
    private ctx: vscode.ExtensionContext,
    private cfg: Config,
    private emitter: Emitter,
    private store: Store,
    private workspaceRoot: string,
  ) {}

  lastAgentWriteMs(): number {
    return this.lastWriteMs;
  }

  async start(): Promise<void> {
    this.offsets = await this.store.loadOffsets();
    this.claudePricing = await this.loadPricing('claude.json');
    this.codexPricing = await this.loadPricing('openai.json');

    // scan initial + poll (les FileSystemWatcher hors workspace ne sont pas garantis,
    // donc on poll ; le watcher sert juste à réagir vite quand il fonctionne)
    await this.scan();
    this.timer = setInterval(() => void this.scan(), POLL_MS);

    for (const dir of [this.cfg.claudeProjectsDir, this.cfg.codexSessionsDir]) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.jsonl'),
        );
        w.onDidChange(() => void this.scan());
        w.onDidCreate(() => void this.scan());
        this.watchers.push(w);
      } catch {
        /* dossier peut ne pas exister encore */
      }
    }
  }

  private async loadPricing(file: string): Promise<PricingTable | undefined> {
    try {
      const p = path.join(this.ctx.extensionPath, 'pricing', file);
      return JSON.parse(await fs.readFile(p, 'utf8')) as PricingTable;
    } catch (e) {
      log(`pricing ${file} not loaded: ${e}`);
      return undefined;
    }
  }

  private async scan(): Promise<void> {
    try {
      await this.scanClaude();
      await this.scanCodex();
      await this.store.saveOffsets(this.offsets);
    } catch (e) {
      log(`agents scan failed: ${e}`);
    }
  }

  private async scanClaude(): Promise<void> {
    const slug = projectPathToClaudeSlug(this.workspaceRoot);
    const dir = path.join(this.cfg.claudeProjectsDir, slug);
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const uuid = name.replace(/\.jsonl$/, '');
      await this.processFile(full, 'claude', uuid, (content, start, fallbackTs) => {
        const r = parseClaudeIncremental(content, start, fallbackTs);
        return {
          nextOffset: r.nextOffset,
          unparsedLines: r.unparsedLines,
          turns: r.turns.map((t) => ({
            byteOffset: t.byteOffset,
            ts: t.ts,
            model: t.model,
            tokens: t.tokens,
            isCumulative: false,
          })),
          meta: undefined,
        };
      });
    }
  }

  private async scanCodex(): Promise<void> {
    const root = this.cfg.codexSessionsDir;
    let files: string[];
    try {
      files = await walkJsonl(root);
    } catch {
      return;
    }
    for (const full of files) {
      const uuid = path.basename(full).replace(/^rollout-.*?-/, '').replace(/\.jsonl$/, '');
      await this.processFile(full, 'codex', uuid, (content, start, fallbackTs) => {
        const r = parseCodexIncremental(content, start, fallbackTs);
        return {
          nextOffset: r.nextOffset,
          unparsedLines: r.unparsedLines,
          meta: r.meta,
          turns: r.turns.map((t) => ({
            byteOffset: t.byteOffset,
            ts: t.ts,
            model: r.meta?.model ?? 'gpt-5-codex',
            tokens: t.tokens,
            isCumulative: t.isCumulative,
          })),
        };
      });
    }
  }

  private async processFile(
    full: string,
    agent: AgentKind,
    uuid: string,
    parse: (
      content: string,
      start: number,
      fallbackTs: string,
    ) => {
      nextOffset: number;
      unparsedLines: number;
      meta: { cwd?: string; model?: string } | undefined;
      turns: Array<{
        byteOffset: number;
        ts: string;
        model: string;
        tokens: AgentTokens;
        isCumulative: boolean;
      }>;
    },
  ): Promise<void> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      return;
    }
    const prev = this.offsets[full] ?? 0;
    if (stat.size <= prev) {
      return; // rien de neuf
    }

    let content: string;
    try {
      content = await fs.readFile(full, 'utf8');
    } catch (e) {
      log(`read ${full} failed: ${e}`);
      return;
    }

    const fallbackTs = stat.mtime.toISOString();
    const result = parse(content, prev, fallbackTs);

    // Codex : filtrer par cwd (rattachement au workspace). Claude : dossier = déjà filtré.
    if (agent === 'codex') {
      const cwd = result.meta?.cwd ?? this.knownCodexCwd.get(full);
      if (cwd) {
        this.knownCodexCwd.set(full, cwd);
      }
      if (!cwd || !isCwdUnder(this.workspaceRoot, cwd)) {
        this.offsets[full] = result.nextOffset;
        return;
      }
    }

    const agg = this.getAgg(agent, uuid, result.meta?.cwd ?? this.workspaceRoot);
    const table = agent === 'claude' ? this.claudePricing : this.codexPricing;

    for (const turn of result.turns) {
      this.lastWriteMs = Date.now();
      agg.endedAt = turn.ts;
      agg.model = turn.model || agg.model;

      // On raisonne toujours en DELTA pour agent_turn et pour le cumul de session :
      //  - source "delta" (Claude, Codex last_token_usage) : le delta = la valeur lue
      //  - source "cumulative" (Codex total_token_usage)   : delta = lu - dernier cumul vu
      let delta: AgentTokens;
      if (turn.isCumulative) {
        delta = diffTokens(turn.tokens, agg.lastCumulative);
        agg.lastCumulative = { ...turn.tokens };
        // un snapshot de cumul n'est pas forcément un "tour" ; on n'incrémente turns
        // que si le delta est non nul.
        if (nonZero(delta)) {
          agg.turns++;
        }
      } else {
        delta = turn.tokens;
        agg.turns++;
      }
      if (!nonZero(delta)) {
        continue; // rien de neuf (re-snapshot identique)
      }
      agg.tokens = addTokens(agg.tokens, delta);

      const turnCost = estimateCost(turn.model, delta, table);
      await this.emitter.emitAt(
        'agent_turn',
        turn.ts,
        {
          agent,
          sessionUuid: uuid,
          model: turn.model,
          ...delta,
          costEstimateUSD: turnCost.costEstimateUSD,
          pricingVersion: turnCost.pricingVersion,
        },
        agentEventId(agent, uuid, turn.byteOffset),
      );
    }
    agg.unparsedLines += result.unparsedLines;
    this.offsets[full] = result.nextOffset;

    if (result.turns.length > 0) {
      await this.flushSession(agg, result.nextOffset);
    }
  }

  private knownCodexCwd = new Map<string, string>();

  private getAgg(agent: AgentKind, uuid: string, cwd: string): SessionAgg {
    const key = `${agent}:${uuid}`;
    let agg = this.sessions.get(key);
    if (!agg) {
      const nowIso = new Date().toISOString();
      agg = {
        agent,
        uuid,
        model: agent === 'claude' ? 'claude-sonnet-5' : 'gpt-5-codex',
        cwd,
        startedAt: nowIso,
        endedAt: nowIso,
        turns: 0,
        tokens: { ...ZERO_TOKENS },
        lastCumulative: { ...ZERO_TOKENS },
        cost: null,
        pricingVersion: null,
        unparsedLines: 0,
      };
      this.sessions.set(key, agg);
    }
    return agg;
  }

  private async flushSession(agg: SessionAgg, byteOffset: number): Promise<void> {
    const table = agg.agent === 'claude' ? this.claudePricing : this.codexPricing;
    const cost = estimateCost(agg.model, agg.tokens, table);
    await this.emitter.emitAt(
      'agent_session',
      agg.endedAt,
      {
        agent: agg.agent,
        sessionUuid: agg.uuid,
        model: agg.model,
        cwd: agg.cwd,
        startedAt: agg.startedAt,
        endedAt: agg.endedAt,
        turns: agg.turns,
        ...agg.tokens,
        costEstimateUSD: cost.costEstimateUSD,
        pricingVersion: cost.pricingVersion,
        unparsedLines: agg.unparsedLines,
      },
      // eventId inclut l'offset de la dernière ligne lue -> chaque version a son id,
      // le rollup garde la version au plus grand offset par sessionUuid.
      agentEventId(agg.agent, agg.uuid, byteOffset),
    );
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watchers.forEach((w) => w.dispose());
    await this.store.saveOffsets(this.offsets);
  }
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}
