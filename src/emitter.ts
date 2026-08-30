/**
 * Point d'entrée unique pour émettre un TrackEvent : ajoute project / branch / sessionId
 * courants, puis délègue au Store. Les trackers appellent `emit(type, payload, eventId?)`.
 */
import { Store } from './store/store.js';
import { currentProjectName } from './workspace.js';
import { liveEventId } from './core/jsonl.js';
import type { EventType, TrackEvent } from './core/types.js';

export class Emitter {
  private sessionId = 'boot';
  private branch: string | undefined;
  private seq = 0;

  constructor(private store: Store) {}

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setBranch(branch: string | undefined): void {
    this.branch = branch;
  }

  currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * @param eventId  fournir un id DÉTERMINISTE pour les événements relus d'une source
   *                 persistante (agents, commits). Sinon un id de séquence est généré.
   */
  emit(type: EventType, payload: unknown, eventId?: string): Promise<void> {
    const ev: TrackEvent = {
      eventId: eventId ?? liveEventId(type, this.sessionId, this.seq++),
      ts: new Date().toISOString(),
      project: currentProjectName(),
      branch: this.branch,
      sessionId: this.sessionId,
      type,
      payload,
    };
    return this.store.append(ev);
  }

  /** Variante avec timestamp explicite (événements horodatés par leur source). */
  emitAt(type: EventType, ts: string, payload: unknown, eventId: string): Promise<void> {
    const ev: TrackEvent = {
      eventId,
      ts,
      project: currentProjectName(),
      branch: this.branch,
      sessionId: this.sessionId,
      type,
      payload,
    };
    return this.store.append(ev);
  }
}
