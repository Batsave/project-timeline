/**
 * À la première ouverture d'un projet (aucune donnée mesurée), reconstruit un
 * historique depuis :
 *   - toutes les sessions Claude Code / Codex CLI (offset 0 -> tout le fichier)
 *   - `git log` complet via l'API vscode.git
 * Les événements agents gardent leur eventId déterministe -> quand le suivi live
 * reprendra, aucun double comptage. Les sessions de temps sont ESTIMÉES (marquées).
 *
 * Après le backfill, on écrit les offsets à la fin de chaque fichier pour que
 * AgentsTracker ne re-parse pas tout.
 */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../store/store.js';
import { log } from '../store/store.js';
import { projectPathToClaudeSlug, isCwdUnder } from '../core/slug.js';
import { parseClaudeIncremental } from '../core/parse-claude.js';
import { parseCodexIncremental } from '../core/parse-codex.js';
import { estimateCost, diffTokens, addTokens, nonZero, ZERO_TOKENS, type PricingTable } from '../core/pricing.js';
import { agentEventId, claudeTurnEventId } from '../core/jsonl.js';
import { buildBackfillEvents, needsBackfill, type BackfillCommit } from '../core/backfill.js';
import { AGENT_CALC_VERSION, type AgentKind, type AgentTokens, type TrackEvent } from '../core/types.js';

export class BackfillRunner {
  constructor(
    private ctx: vscode.ExtensionContext,
    private cfg: Config,
    private store: Store,
    private workspaceRoot: string,
    private project: string,
  ) {}

  /** @returns true si un backfill a été effectué. */
  async runIfNeeded(): Promise<boolean> {
    const existing = await this.store.readAllEvents();
    if (!needsBackfill(existing, this.project)) {
      return false;
    }

    log('backfill : première ouverture, reconstruction de l’historique…');
    const claudePricing = await this.loadPricing('claude.json');
    const codexPricing = await this.loadPricing('openai.json');

    const offsets = await this.store.loadOffsets();
    const agentEvents: TrackEvent[] = [];

    const claudeCount = await this.scanClaudeHistory(agentEvents, offsets, claudePricing);
    const codexCount = await this.scanCodexHistory(agentEvents, offsets, codexPricing);
    const commits = await this.readGitLog();

    const events = buildBackfillEvents({
      project: this.project,
      agentEvents,
      commits,
      nowTs: Date.now(),
    });

    for (const ev of events) {
      await this.store.append(ev);
    }
    await this.store.saveOffsets(offsets);

    log(
      `backfill terminé : ${claudeCount} tours Claude, ${codexCount} tours Codex, ` +
        `${commits.length} commits, ${events.length} événements écrits.`,
    );
    return true;
  }

  private async loadPricing(file: string): Promise<PricingTable | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.ctx.extensionPath, 'pricing', file), 'utf8'),
      ) as PricingTable;
    } catch {
      return undefined;
    }
  }

  private async scanClaudeHistory(
    out: TrackEvent[],
    offsets: Record<string, number>,
    pricing: PricingTable | undefined,
  ): Promise<number> {
    const dir = path.join(this.cfg.claudeProjectsDir, projectPathToClaudeSlug(this.workspaceRoot));
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of files) {
      const full = path.join(dir, name);
      const uuid = name.replace(/\.jsonl$/, '');
      let content: string;
      let mtimeIso: string;
      try {
        const st = await fs.stat(full);
        mtimeIso = st.mtime.toISOString();
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const r = parseClaudeIncremental(content, 0, mtimeIso);
      const agg = this.newAgg('claude', uuid);
      for (const t of r.turns) {
        agg.turns++;
        agg.endedAt = t.ts;
        agg.model = t.model || agg.model;
        agg.tokens = addTokens(agg.tokens, t.tokens);
        const cost = estimateCost(t.model, t.tokens, pricing);
        const eventId = claudeTurnEventId(uuid, t.messageId, t.byteOffset);
        out.push(this.turnEvent('claude', uuid, t.ts, t.model, t.tokens, cost, eventId));
        count++;
      }
      if (r.turns.length) {
        out.push(this.sessionEvent(agg, pricing, r.nextOffset));
      }
      offsets[full] = r.nextOffset;
    }
    return count;
  }

  private async scanCodexHistory(
    out: TrackEvent[],
    offsets: Record<string, number>,
    pricing: PricingTable | undefined,
  ): Promise<number> {
    const root = this.cfg.codexSessionsDir;
    let files: string[];
    try {
      files = await walkJsonl(root);
    } catch {
      return 0;
    }
    let count = 0;
    for (const full of files) {
      let content: string;
      let mtimeIso: string;
      try {
        const st = await fs.stat(full);
        mtimeIso = st.mtime.toISOString();
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const r = parseCodexIncremental(content, 0, mtimeIso);
      if (!r.meta?.cwd || !isCwdUnder(this.workspaceRoot, r.meta.cwd)) {
        offsets[full] = r.nextOffset;
        continue;
      }
      const uuid = path.basename(full).replace(/^rollout-.*?-/, '').replace(/\.jsonl$/, '');
      const model = r.meta.model ?? 'gpt-5-codex';
      const agg = this.newAgg('codex', uuid);
      agg.model = model;
      let lastCum: AgentTokens = { ...ZERO_TOKENS };
      for (const t of r.turns) {
        const delta = t.isCumulative ? diffTokens(t.tokens, lastCum) : t.tokens;
        if (t.isCumulative) lastCum = { ...t.tokens };
        if (!nonZero(delta)) continue;
        agg.turns++;
        agg.endedAt = t.ts;
        agg.tokens = addTokens(agg.tokens, delta);
        const cost = estimateCost(model, delta, pricing);
        const eventId = agentEventId('codex', uuid, t.byteOffset);
        out.push(this.turnEvent('codex', uuid, t.ts, model, delta, cost, eventId));
        count++;
      }
      if (agg.turns) {
        out.push(this.sessionEvent(agg, pricing, r.nextOffset));
      }
      offsets[full] = r.nextOffset;
    }
    return count;
  }

  private async readGitLog(): Promise<BackfillCommit[]> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return [];
    try {
      const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
      const repo = api.repositories.find(
        (r: any) => isCwdUnder(this.workspaceRoot, r.rootUri.fsPath) || isCwdUnder(r.rootUri.fsPath, this.workspaceRoot),
      );
      if (!repo) return [];
      const branch: string = repo.state.HEAD?.name ?? '';
      const commits: any[] = await repo.log({ maxEntries: 5000 });
      const out: BackfillCommit[] = [];
      for (const c of commits) {
        let insertions = 0;
        let deletions = 0;
        let filesChanged = 0;
        try {
          const parent = c.parents?.[0];
          if (parent) {
            const changes: any[] = await repo.diffBetweenWithStats(parent, c.hash);
            filesChanged = changes.length;
            for (const ch of changes) {
              insertions += ch.insertions ?? 0;
              deletions += ch.deletions ?? 0;
            }
          }
        } catch {
          /* commit racine ou diff indispo */
        }
        out.push({
          hash: c.hash,
          message: (c.message ?? '').split('\n')[0],
          author: c.authorName ?? c.authorEmail ?? 'unknown',
          branch,
          isoDate: (c.authorDate instanceof Date ? c.authorDate : new Date()).toISOString(),
          insertions,
          deletions,
          filesChanged,
        });
      }
      return out;
    } catch (e) {
      log(`backfill git log échoué : ${e}`);
      return [];
    }
  }

  // --- helpers agrégat ---

  private newAgg(agent: AgentKind, uuid: string) {
    const nowIso = new Date().toISOString();
    return {
      agent,
      uuid,
      model: agent === 'claude' ? 'unknown' : 'gpt-5-codex',
      startedAt: nowIso,
      endedAt: nowIso,
      turns: 0,
      tokens: { ...ZERO_TOKENS } as AgentTokens,
      unparsedLines: 0,
    };
  }

  private turnEvent(
    agent: AgentKind,
    uuid: string,
    ts: string,
    model: string,
    tokens: AgentTokens,
    cost: ReturnType<typeof estimateCost>,
    eventId: string,
  ): TrackEvent {
    return {
      eventId,
      ts,
      project: this.project,
      sessionId: 'bf_agents',
      type: 'agent_turn',
      payload: {
        agent,
        sessionUuid: uuid,
        model,
        ...tokens,
        costEstimateUSD: cost.costEstimateUSD,
        pricingVersion: cost.pricingVersion,
        calcVersion: AGENT_CALC_VERSION,
      },
    };
  }

  private sessionEvent(
    agg: ReturnType<BackfillRunner['newAgg']>,
    pricing: PricingTable | undefined,
    byteOffset: number,
  ): TrackEvent {
    const cost = estimateCost(agg.model, agg.tokens, pricing);
    return {
      eventId: agentEventId(agg.agent, agg.uuid, byteOffset),
      ts: agg.endedAt,
      project: this.project,
      sessionId: 'bf_agents',
      type: 'agent_session',
      payload: {
        agent: agg.agent,
        sessionUuid: agg.uuid,
        model: agg.model,
        cwd: this.workspaceRoot,
        startedAt: agg.startedAt,
        endedAt: agg.endedAt,
        turns: agg.turns,
        ...agg.tokens,
        costEstimateUSD: cost.costEstimateUSD,
        pricingVersion: cost.pricingVersion,
        unparsedLines: agg.unparsedLines,
        calcVersion: AGENT_CALC_VERSION,
      },
    };
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
      if (e.isDirectory()) await rec(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await rec(root);
  return out;
}
