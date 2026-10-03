/**
 * Persistance disque. Écrit UNIQUEMENT dans context.globalStorageUri.
 * - events.jsonl   : log append-only
 * - offsets.json   : cache d'optimisation {absPathSource: byteOffset} (pas une source de vérité)
 * - git-cursor.json: {repoRoot: lastHash}
 * - heartbeat.json : session ouverte pour recovery
 * - data-version.json : version de l'extension / du calcul ayant produit la log (migrations)
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
  private dataVersionPath: string;
  private lockPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = ctx.globalStorageUri.fsPath;
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.offsetsPath = path.join(this.dir, 'offsets.json');
    this.gitCursorPath = path.join(this.dir, 'git-cursor.json');
    this.heartbeatPath = path.join(this.dir, 'heartbeat.json');
    this.dataVersionPath = path.join(this.dir, 'data-version.json');
    this.lockPath = path.join(this.dir, 'migration.lock');
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

  /** Événements décodés + taille (octets) du fichier lu, pour `rewriteEvents`. */
  async readEventsSnapshot(): Promise<{ events: TrackEvent[]; size: number }> {
    try {
      const buf = await fs.readFile(this.eventsPath);
      return { events: decodeEvents(buf.toString('utf8')), size: buf.length };
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) {
        log(`readEventsSnapshot failed: ${e}`);
      }
      return { events: [], size: 0 };
    }
  }

  /**
   * Remplace la log par `events` (compaction / migration). Le fichier est partagé par
   * toutes les fenêtres VS Code : ce qu'elles ont ajouté depuis le snapshot (octets au-delà
   * de `snapshotSize`) est recopié tel quel à la fin avant le remplacement atomique.
   */
  async rewriteEvents(events: TrackEvent[], snapshotSize: number): Promise<void> {
    const tmp = this.eventsPath + '.rewrite';
    const write = async (): Promise<void> => {
      const fh = await fs.open(tmp, 'w');
      try {
        const CHUNK = 5_000;
        for (let i = 0; i < events.length; i += CHUNK) {
          await fh.write(events.slice(i, i + CHUNK).map(encodeEvent).join(''));
        }
        const tail = await this.readFrom(snapshotSize);
        if (tail.length) {
          await fh.write(tail);
        }
      } finally {
        await fh.close();
      }
      await renameWithRetry(tmp, this.eventsPath);
    };
    this.writeQueue = this.writeQueue.then(write);
    await this.writeQueue;
  }

  private async readFrom(offset: number): Promise<Buffer> {
    const fh = await fs.open(this.eventsPath, 'r');
    try {
      const { size } = await fh.stat();
      if (size <= offset) {
        return Buffer.alloc(0);
      }
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async loadDataVersion(): Promise<{ extensionVersion: string; calcVersion: number } | null> {
    return this.readJson(this.dataVersionPath, null);
  }

  async saveDataVersion(v: { extensionVersion: string; calcVersion: number }): Promise<void> {
    await this.writeJson(this.dataVersionPath, v);
  }

  /** Verrou inter-fenêtres pour les migrations. Un verrou de plus de 10 min est ignoré. */
  async tryLock(): Promise<boolean> {
    try {
      const st = await fs.stat(this.lockPath);
      if (Date.now() - st.mtimeMs < 10 * 60_000) {
        return false;
      }
      await fs.rm(this.lockPath, { force: true });
    } catch {
      /* pas de verrou */
    }
    try {
      await (await fs.open(this.lockPath, 'wx')).close();
      return true;
    } catch {
      return false;
    }
  }

  async unlock(): Promise<void> {
    await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
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

/** Windows refuse de remplacer un fichier ouvert par un autre process : on réessaie. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 50));
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
