/**
 * Machine à états du temps de travail. PURE : on lui pousse des "ticks" avec un
 * horodatage et l'état des signaux, elle produit des SessionPayload à `flush()`.
 * Le câblage vscode (events éditeur, focus, watcher d'agents, timers) vit ailleurs.
 *
 * Règle `alive` — la session reste ouverte tant que l'un est vrai :
 *   - interaction éditeur récente (< idleTimeout)
 *   - agent actif (une écriture de session d'agent il y a < agentGrace)
 *   - fenêtre au premier plan ET < idleTimeout depuis la dernière interaction
 *     (le focus SEUL ne prolonge que la fenêtre de tolérance, pas indéfiniment)
 *
 * Les 7 dimensions de temps SE CHEVAUCHENT (voir SessionPayload).
 */
import type { SessionPayload } from './types.js';

export interface ActivityConfig {
  idleTimeoutMs: number;
  agentGraceMs: number;
  minSessionMs: number;
}

export interface TickInput {
  now: number; // ms epoch
  /** une interaction éditeur (frappe/sélection/save/changement d'éditeur) a eu lieu à ce tick. */
  interaction: boolean;
  /** la fenêtre VS Code est au premier plan. */
  focused: boolean;
  /** dernière écriture connue d'une session d'agent du projet (ms epoch), ou 0. */
  lastAgentWriteMs: number;
}

export interface OpenSession {
  sessionId: string;
  startedAt: number;
  lastTickAt: number;
  lastInteractionAt: number;
  lastAgentSignalAt: number;
  acc: SessionPayload;
}

export interface FlushedSession {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  payload: SessionPayload;
}

function zeroPayload(): SessionPayload {
  return {
    durationMs: 0,
    focusMs: 0,
    interactionMs: 0,
    agentPresentMs: 0,
    agentOnlyMs: 0,
    focusOnlyMs: 0,
    idleMs: 0,
  };
}

export class ActivityTracker {
  private session: OpenSession | null = null;

  constructor(
    private cfg: ActivityConfig,
    private makeSessionId: (startedAt: number) => string,
  ) {}

  /** Réhydrate une session ouverte depuis un heartbeat persisté (recovery). */
  restore(session: OpenSession): void {
    this.session = session;
  }

  current(): OpenSession | null {
    return this.session;
  }

  /**
   * Traite un tick. Retourne une session à enregistrer si elle vient d'être clôturée
   * (et qu'elle dépasse minSessionMs), sinon null.
   */
  tick(input: TickInput): FlushedSession | null {
    const { now } = input;
    const interaction = input.interaction;
    const agentActive =
      input.lastAgentWriteMs > 0 && now - input.lastAgentWriteMs < this.cfg.agentGraceMs;

    // La session en cours (si présente) fournit lastInteractionAt pour la règle focus.
    const lastInteractionAt = this.session
      ? interaction
        ? now
        : this.session.lastInteractionAt
      : now;

    const focusKeepsAlive =
      input.focused && now - lastInteractionAt < this.cfg.idleTimeoutMs;
    const alive = interaction || agentActive || focusKeepsAlive;

    if (!alive) {
      return this.closeIfWorthIt(now);
    }

    if (!this.session) {
      const startedAt = now;
      this.session = {
        sessionId: this.makeSessionId(startedAt),
        startedAt,
        lastTickAt: now,
        lastInteractionAt: interaction ? now : now, // au démarrage on suppose une interaction
        lastAgentSignalAt: agentActive ? now : 0,
        acc: zeroPayload(),
      };
      return null;
    }

    const s = this.session;
    let delta = now - s.lastTickAt;
    if (delta <= 0) {
      s.lastTickAt = now;
      return null;
    }
    // Un gros écart (machine en veille, process gelé) est borné à idleTimeout :
    // on ne crédite jamais plus que la fenêtre de tolérance sur un seul tick.
    if (delta > this.cfg.idleTimeoutMs) {
      delta = this.cfg.idleTimeoutMs;
    }

    s.acc.durationMs += delta;
    if (input.focused) {
      s.acc.focusMs += delta;
    }
    if (interaction) {
      s.acc.interactionMs += delta;
      s.lastInteractionAt = now;
    }
    if (agentActive) {
      s.acc.agentPresentMs += delta;
      s.lastAgentSignalAt = now;
    }
    if (agentActive && !interaction) {
      s.acc.agentOnlyMs += delta;
    }
    if (input.focused && !interaction && !agentActive) {
      s.acc.focusOnlyMs += delta;
    }
    if (!interaction && !agentActive) {
      s.acc.idleMs += delta;
    }
    s.lastTickAt = now;
    return null;
  }

  /** Fermeture propre (deactivate). */
  flush(now: number): FlushedSession | null {
    return this.closeIfWorthIt(now);
  }

  private closeIfWorthIt(now: number): FlushedSession | null {
    const s = this.session;
    this.session = null;
    if (!s) {
      return null;
    }
    if (s.acc.durationMs < this.cfg.minSessionMs) {
      return null;
    }
    return {
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      endedAt: now,
      payload: s.acc,
    };
  }
}
