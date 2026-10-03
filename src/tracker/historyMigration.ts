/**
 * Corrige l'historique agents à chaque changement de version de l'extension (prix mis
 * à jour) ou du calcul des tokens (AGENT_CALC_VERSION), et dès que la log contient des
 * événements d'une ancienne version (fenêtre restée sur l'ancien code, par ex.).
 *
 * Toutes les sessions d'agent de la log sont traitées, quel que soit le projet : leur
 * fichier source est cherché par uuid dans ~/.claude/projects/* et ~/.codex/sessions.
 * La logique de correction est dans core/migrate.ts ; ici, uniquement le disque.
 */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../store/store.js';
import { log } from '../store/store.js';
import { parseClaudeIncremental } from '../core/parse-claude.js';
import { parseCodexIncremental } from '../core/parse-codex.js';
import { diffTokens, nonZero, ZERO_TOKENS, type PricingTable } from '../core/pricing.js';
import {
  agentSessionsIn,
  hasStaleAgentEvents,
  migrateAgentHistory,
  sessionKey,
  type ReparsedSession,
} from '../core/migrate.js';
import { AGENT_CALC_VERSION, type AgentKind, type AgentTokens } from '../core/types.js';

export class HistoryMigration {
  constructor(
    private ctx: vscode.ExtensionContext,
    private cfg: Config,
    private store: Store,
  ) {}

  /** @returns true si la log a été réécrite. */
  async runIfNeeded(): Promise<boolean> {
    const extensionVersion = String(this.ctx.extension.packageJSON.version ?? '0');
    const target = { extensionVersion, calcVersion: AGENT_CALC_VERSION };
    const stored = await this.store.loadDataVersion();
    const snapshot = await this.store.readEventsSnapshot();

    const upToDate =
      stored?.extensionVersion === extensionVersion && stored.calcVersion === AGENT_CALC_VERSION;
    if (snapshot.events.length === 0 || (upToDate && !hasStaleAgentEvents(snapshot.events))) {
      if (!upToDate) await this.store.saveDataVersion(target);
      return false;
    }
    if (!(await this.store.tryLock())) {
      log('migration : une autre fenêtre migre déjà la log, on passe.');
      return false;
    }

    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Project Timeline: recomputing agent token history…'),
        },
        async () => {
          const started = Date.now();
          const pricing = {
            claude: await this.loadPricing('claude.json'),
            codex: await this.loadPricing('openai.json'),
          };
          const sources = await this.indexSources();
          const offsets = await this.store.loadOffsets();
          const reparsed = new Map<string, ReparsedSession>();

          for (const { agent, uuid } of agentSessionsIn(snapshot.events)) {
            const file = sources.get(sessionKey(agent, uuid));
            if (!file) continue;
            const session = await reparseFile(agent, file);
            if (!session) continue;
            reparsed.set(sessionKey(agent, uuid), session);
            offsets[file] = session.nextOffset;
          }

          const result = migrateAgentHistory({ events: snapshot.events, pricing, reparsed });
          await this.store.rewriteEvents(result.events, snapshot.size);
          await this.store.saveOffsets(offsets);
          await this.store.saveDataVersion(target);
          log(
            `migration ${stored?.extensionVersion ?? '?'} -> ${extensionVersion} ` +
              `(calcul v${AGENT_CALC_VERSION}) : ${result.reparsedSessions} sessions re-parsées, ` +
              `${result.upgradedSessions} corrigées sans source, ` +
              `${snapshot.events.length} -> ${result.events.length} événements ` +
              `en ${Date.now() - started} ms.`,
          );
          return true;
        },
      );
    } catch (e) {
      log(`migration échouée (log inchangée) : ${e}`);
      return false;
    } finally {
      await this.store.unlock();
    }
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

  /** `agent:uuid` -> chemin du fichier de session, tous projets confondus. */
  private async indexSources(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.readdir(this.cfg.claudeProjectsDir);
    } catch {
      /* pas de Claude Code */
    }
    for (const d of projectDirs) {
      const dir = path.join(this.cfg.claudeProjectsDir, d);
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        out.set(sessionKey('claude', f.replace(/\.jsonl$/, '')), path.join(dir, f));
      }
    }
    for (const full of await walkJsonl(this.cfg.codexSessionsDir)) {
      const uuid = path.basename(full).replace(/^rollout-.*?-/, '').replace(/\.jsonl$/, '');
      out.set(sessionKey('codex', uuid), full);
    }
    return out;
  }
}

/** Re-parse complet d'un fichier de session ; les cumuls Codex sont convertis en deltas. */
async function reparseFile(agent: AgentKind, file: string): Promise<ReparsedSession | null> {
  let content: string;
  let mtimeIso: string;
  try {
    const st = await fs.stat(file);
    mtimeIso = st.mtime.toISOString();
    content = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }

  if (agent === 'claude') {
    const r = parseClaudeIncremental(content, 0, mtimeIso);
    return { turns: r.turns, nextOffset: r.nextOffset, unparsedLines: r.unparsedLines };
  }

  const r = parseCodexIncremental(content, 0, mtimeIso);
  const model = r.meta?.model ?? 'gpt-5-codex';
  let lastCum: AgentTokens = { ...ZERO_TOKENS };
  const turns: ReparsedSession['turns'] = [];
  for (const t of r.turns) {
    const delta = t.isCumulative ? diffTokens(t.tokens, lastCum) : t.tokens;
    if (t.isCumulative) lastCum = { ...t.tokens };
    if (!nonZero(delta)) continue;
    turns.push({ byteOffset: t.byteOffset, ts: t.ts, model, tokens: delta });
  }
  return { turns, nextOffset: r.nextOffset, unparsedLines: r.unparsedLines };
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
