/**
 * Câblage vscode de la machine à états `core/activity`.
 * - signale les interactions éditeur + le focus
 * - interroge le "dernier écrit d'un agent" fourni par AgentsTracker
 * - tick toutes les 15 s, heartbeat toutes les 30 s
 * - recovery conservateur au démarrage
 */
import * as vscode from 'vscode';
import { ActivityTracker, type OpenSession } from '../core/activity.js';
import type { Config } from '../config.js';
import type { Emitter } from '../emitter.js';
import type { Store } from '../store/store.js';
import { log } from '../store/store.js';
import type { SessionPayload } from '../core/types.js';

const TICK_MS = 15_000;
const HEARTBEAT_MS = 30_000;

interface HeartbeatShape {
  session: OpenSession;
}

export class ActivityTrackerVS {
  private core: ActivityTracker;
  private interactionSinceLastTick = false;
  private lastAgentWriteMs = 0;
  private tickTimer?: NodeJS.Timeout;
  private hbTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private cfg: Config,
    private emitter: Emitter,
    private store: Store,
  ) {
    this.core = new ActivityTracker(
      {
        idleTimeoutMs: cfg.idleTimeoutMs,
        agentGraceMs: cfg.agentGraceMs,
        minSessionMs: cfg.minSessionMs,
      },
      (startedAt) => makeSessionId(startedAt),
    );
  }

  /** Injecté par l'extension : renvoie le ms epoch du dernier écrit d'un agent du projet. */
  setAgentWriteProbe(probe: () => number): void {
    this.agentWriteProbe = probe;
  }
  private agentWriteProbe: () => number = () => 0;

  async start(): Promise<void> {
    await this.recover();

    const bump = () => {
      this.interactionSinceLastTick = true;
    };
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(bump),
      vscode.window.onDidChangeTextEditorSelection(bump),
      vscode.workspace.onDidSaveTextDocument(bump),
      vscode.window.onDidChangeActiveTextEditor(bump),
    );

    this.tickTimer = setInterval(() => this.doTick(), TICK_MS);
    this.hbTimer = setInterval(() => void this.saveHeartbeat(), HEARTBEAT_MS);
    // premier tick immédiat pour ouvrir la session si on démarre en travaillant
    this.doTick();
  }

  private doTick(): void {
    const now = Date.now();
    this.lastAgentWriteMs = this.agentWriteProbe();
    const focused = vscode.window.state.focused;
    const interaction = this.interactionSinceLastTick;
    this.interactionSinceLastTick = false;

    const flushed = this.core.tick({
      now,
      interaction,
      focused,
      lastAgentWriteMs: this.lastAgentWriteMs,
    });
    if (flushed) {
      void this.emitter
        .emitAt('session', new Date(flushed.endedAt).toISOString(), flushed.payload, `session:${flushed.sessionId}:0`)
        .then(() => this.store.clearHeartbeat());
    }
    // met à jour le sessionId courant pour que les autres trackers rattachent leurs events
    const open = this.core.current();
    this.emitter.setSessionId(open ? open.sessionId : `idle_${Math.floor(now / 60000)}`);
  }

  private async saveHeartbeat(): Promise<void> {
    const open = this.core.current();
    if (!open) {
      await this.store.clearHeartbeat();
      return;
    }
    await this.store.saveHeartbeat({ session: open } satisfies HeartbeatShape);
  }

  private async recover(): Promise<void> {
    const hb = await this.store.loadHeartbeat<HeartbeatShape>();
    if (!hb?.session) {
      return;
    }
    // Recovery CONSERVATEUR : on enregistre l'état persisté tel quel, sans rien reconstruire.
    const s = hb.session;
    if (isValidPayload(s.acc) && s.acc.durationMs >= this.cfg.minSessionMs) {
      await this.emitter.emitAt(
        'session',
        new Date(s.lastTickAt || Date.now()).toISOString(),
        s.acc,
        `session:${s.sessionId}:0`,
      );
      log(`recovered session ${s.sessionId} (${Math.round(s.acc.durationMs / 1000)}s)`);
    }
    await this.store.clearHeartbeat();
  }

  async dispose(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.disposables.forEach((d) => d.dispose());
    const flushed = this.core.flush(Date.now());
    if (flushed) {
      await this.emitter.emitAt(
        'session',
        new Date(flushed.endedAt).toISOString(),
        flushed.payload,
        `session:${flushed.sessionId}:0`,
      );
    }
    await this.store.clearHeartbeat();
  }
}

function makeSessionId(startedAt: number): string {
  const iso = new Date(startedAt).toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `s_${iso}_${rand}`;
}

function isValidPayload(p: unknown): p is SessionPayload {
  return !!p && typeof p === 'object' && typeof (p as SessionPayload).durationMs === 'number';
}
