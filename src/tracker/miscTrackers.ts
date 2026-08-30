/**
 * Trackers légers : tasks, debug, diagnostics.
 */
import * as vscode from 'vscode';
import type { Config } from '../config.js';
import type { Emitter } from '../emitter.js';

export class TaskTracker {
  private starts = new Map<string, number>();
  private d: vscode.Disposable[] = [];
  constructor(private emitter: Emitter) {}

  start(): void {
    this.d.push(
      vscode.tasks.onDidStartTask((e) => {
        this.starts.set(e.execution.task.name, Date.now());
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        const name = e.execution.task.name;
        const startedAt = this.starts.get(name);
        this.starts.delete(name);
        void this.emitter.emit('task_run', {
          name,
          ok: e.exitCode === 0,
          durationMs: startedAt ? Date.now() - startedAt : 0,
        });
      }),
    );
  }
  dispose(): void {
    this.d.forEach((x) => x.dispose());
  }
}

export class DebugTracker {
  private starts = new Map<string, number>();
  private d: vscode.Disposable[] = [];
  constructor(private emitter: Emitter) {}

  start(): void {
    this.d.push(
      vscode.debug.onDidStartDebugSession((s) => {
        this.starts.set(s.id, Date.now());
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        const startedAt = this.starts.get(s.id);
        this.starts.delete(s.id);
        void this.emitter.emit('debug_session', {
          name: s.name,
          durationMs: startedAt ? Date.now() - startedAt : 0,
        });
      }),
    );
  }
  dispose(): void {
    this.d.forEach((x) => x.dispose());
  }
}

export class DiagnosticsTracker {
  private timer?: NodeJS.Timeout;
  private lastTotal = -1;
  private d: vscode.Disposable[] = [];

  constructor(
    private cfg: Config,
    private emitter: Emitter,
  ) {}

  start(): void {
    this.d.push(
      vscode.languages.onDidChangeDiagnostics(() => this.schedule()),
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.snapshot();
    }, this.cfg.diagnosticsDebounceMs);
  }

  private async snapshot(): Promise<void> {
    let errors = 0;
    let warnings = 0;
    const byLanguage: Record<string, { errors: number; warnings: number }> = {};

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const lang = uri.fsPath.split('.').pop()?.toLowerCase() ?? 'unknown';
      for (const dg of diags) {
        const bucket = (byLanguage[lang] ??= { errors: 0, warnings: 0 });
        if (dg.severity === vscode.DiagnosticSeverity.Error) {
          errors++;
          bucket.errors++;
        } else if (dg.severity === vscode.DiagnosticSeverity.Warning) {
          warnings++;
          bucket.warnings++;
        }
      }
    }

    const total = errors + warnings;
    if (total === this.lastTotal) {
      return;
    }
    this.lastTotal = total;
    await this.emitter.emit('diagnostics', { errors, warnings, byLanguage });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.d.forEach((x) => x.dispose());
  }
}
