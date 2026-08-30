/**
 * EXPÉRIMENTAL. Observe les commandes lancées dans le terminal intégré via la shell
 * integration (VS Code >= 1.93). Pas d'API publique pour observer le Test Explorer
 * d'autres extensions -> on se limite au terminal. Si la shell integration est
 * indisponible, on ne compte rien (on ne fabrique pas de chiffres).
 */
import * as vscode from 'vscode';
import type { Emitter } from '../emitter.js';
import { log } from '../store/store.js';
import { looksLikeTestCommand, parseTestOutput } from '../core/parse-tests.js';

const MAX_BUFFER = 1_000_000; // 1 Mo, on garde la fin (ring buffer)

interface Running {
  commandLine: string;
  startedAt: number;
  chunks: string[];
  size: number;
}

export class TestsTracker {
  private running = new Map<object, Running>();
  private d: vscode.Disposable[] = [];

  constructor(private emitter: Emitter) {}

  start(): void {
    const anyWin = vscode.window as any;
    if (
      typeof anyWin.onDidStartTerminalShellExecution !== 'function' ||
      typeof anyWin.onDidEndTerminalShellExecution !== 'function'
    ) {
      log('shell integration indisponible — comptage des tests désactivé');
      return;
    }

    this.d.push(
      anyWin.onDidStartTerminalShellExecution((e: any) => this.onStart(e)),
      anyWin.onDidEndTerminalShellExecution((e: any) => void this.onEnd(e)),
    );
  }

  private onStart(e: any): void {
    const commandLine: string =
      typeof e.execution?.commandLine === 'string'
        ? e.execution.commandLine
        : e.execution?.commandLine?.value ?? '';
    if (!looksLikeTestCommand(commandLine)) {
      return;
    }
    const rec: Running = { commandLine, startedAt: Date.now(), chunks: [], size: 0 };
    this.running.set(e.execution, rec);

    // lire IMMÉDIATEMENT, sinon on rate le début de la sortie
    (async () => {
      try {
        for await (const chunk of e.execution.read()) {
          rec.chunks.push(chunk);
          rec.size += chunk.length;
          while (rec.size > MAX_BUFFER && rec.chunks.length > 1) {
            rec.size -= rec.chunks[0].length;
            rec.chunks.shift();
          }
        }
      } catch (err) {
        log(`terminal read failed: ${err}`);
      }
    })();
  }

  private async onEnd(e: any): Promise<void> {
    const rec = this.running.get(e.execution);
    if (!rec) {
      return;
    }
    this.running.delete(e.execution);
    const output = rec.chunks.join('');
    const summary = parseTestOutput(output);
    const exitCode: number | undefined =
      typeof e.exitCode === 'number' ? e.exitCode : undefined;

    if (!summary) {
      // pas de résumé exploitable : on ne compte pas (par principe)
      log(`test cmd sans résumé reconnaissable: ${rec.commandLine}`);
      return;
    }
    await this.emitter.emit('test_run', {
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      durationMs: Date.now() - rec.startedAt,
      source: 'terminal',
      command: rec.commandLine.slice(0, 300),
      exitCode,
    });
  }

  dispose(): void {
    this.d.forEach((x) => x.dispose());
  }
}
