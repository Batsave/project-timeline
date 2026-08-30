/**
 * Encodage / décodage de la log d'événements append-only, et déduplication par eventId.
 * PURE : pas d'accès disque (le composant vscode fait fs.appendFile / fs.readFile).
 */
import type { TrackEvent } from './types.js';

export function encodeEvent(ev: TrackEvent): string {
  return JSON.stringify(ev) + '\n';
}

/**
 * Décode un contenu JSONL. Les lignes illisibles sont ignorées (log défensif ailleurs).
 * La déduplication par `eventId` : la PREMIÈRE occurrence gagne, sauf `agent_session`
 * où l'on garde la version au plus grand byteOffset (cumul le plus récent).
 */
export function decodeEvents(content: string): TrackEvent[] {
  const byId = new Map<string, TrackEvent>();
  const order: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let ev: TrackEvent;
    try {
      ev = JSON.parse(trimmed) as TrackEvent;
    } catch {
      continue;
    }
    if (!ev || typeof ev.eventId !== 'string' || typeof ev.type !== 'string') {
      continue;
    }
    const existing = byId.get(ev.eventId);
    if (!existing) {
      byId.set(ev.eventId, ev);
      order.push(ev.eventId);
      continue;
    }
    if (ev.type === 'agent_session' && agentSessionOffset(ev) > agentSessionOffset(existing)) {
      byId.set(ev.eventId, ev);
    }
  }

  return order.map((id) => byId.get(id)!);
}

/** L'eventId d'un agent_session est `<agent>:<uuid>:<byteOffset>`. */
function agentSessionOffset(ev: TrackEvent): number {
  const parts = ev.eventId.split(':');
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : 0;
}

/** eventId déterministe pour un tour / une session d'agent. */
export function agentEventId(
  agent: string,
  sessionUuid: string,
  byteOffset: number,
): string {
  return `${agent}:${sessionUuid}:${byteOffset}`;
}

/** eventId d'un commit. */
export function commitEventId(hash: string): string {
  return `commit:${hash}`;
}

/** eventId de séquence pour un événement généré une seule fois en live. */
export function liveEventId(type: string, sessionId: string, seq: number): string {
  return `${type}:${sessionId}:${seq}`;
}
