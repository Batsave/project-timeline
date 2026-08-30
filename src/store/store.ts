/**
 * Persistance disque. Écrit UNIQUEMENT dans context.globalStorageUri.
 * - events.jsonl   : log append-only
 * - offsets.json   : cache d'optimisation {absPathSource: byteOffset} (pas une source de vérité)
 * - git-cursor.json: {repoRoot: lastHash}
 * - heartbeat.json : session ouverte pour recovery
 * - rollups/       : (réservé) caches d'agrégats
 */
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { encodeEvent, decodeEvents } from '../core/jsonl.js';
import type { TrackEvent } from '../core/types.js';

export class Store {
  private dir: string;
  private eventsPath: string;
  private offsetsPath: string;
  private gitCursorPath: string;
  private heartbeatPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = ctx.globalStorageUri.fsPath;
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.offsetsPath = path.join(this.dir, 'offsets.json');
    this.gitCursorPath = path.join(this.dir, 'git-cursor.json');
    this.heartbeatPath = path.join(this.dir, 'heartbeat.json');
  }

  get dataFolder(): string {
    return this.dir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Append sérialisé : jamais deux écritures concurrentes sur le fichier. */
  append(ev: TrackEvent): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.eventsPath, encodeEvent(ev), 'utf8'))
      .catch((e) => log(`append failed: ${e}`));
    return this.writeQueue;
  }

  async readAllEvents(): Promise<TrackEvent[]> {
    try {
      const content = await fs.readFile(this.eventsPath, 'utf8');
      return decodeEvents(content);
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
        return [];
      }
      log(`readAllEvents failed: ${e}`);
      return [];
    }
  }

  async loadOffsets(): Promise<Record<string, number>> {
    return this.readJson(this.offsetsPath, {});
  }

  async saveOffsets(offsets: Record<string, number>): Promise<void> {
    await this.writeJson(this.offsetsPath, offsets);
  }

  async loadGitCursor(): Promise<Record<string, string>> {
    return this.readJson(this.gitCursorPath, {});
  }

  async saveGitCursor(cursor: Record<string, string>): Promise<void> {
    await this.writeJson(this.gitCursorPath, cursor);
  }

  async loadHeartbeat<T>(): Promise<T | null> {
    return this.readJson<T | null>(this.heartbeatPath, null);
  }

  async saveHeartbeat(hb: unknown): Promise<void> {
    await this.writeJson(this.heartbeatPath, hb);
  }

  async clearHeartbeat(): Promise<void> {
    try {
      await fs.rm(this.heartbeatPath, { force: true });
    } catch (e) {
      log(`clearHeartbeat failed: ${e}`);
    }
  }

  private async readJson<T>(p: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(p: string, value: unknown): Promise<void> {
    try {
      const tmp = p + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
      await fs.rename(tmp, p);
    } catch (e) {
      log(`writeJson ${path.basename(p)} failed: ${e}`);
    }
  }
}

let channel: vscode.OutputChannel | undefined;
export function setLogChannel(c: vscode.OutputChannel): void {
  channel = c;
}
export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  channel?.appendLine(line);
}
