/**
 * file_edit : lignes ajoutées/supprimées DANS L'ÉDITEUR, agrégées par fichier et
 * par fenêtre de `fileEditFlushMs`. C'est ce que l'utilisateur tape.
 * file_fs : opérations OBSERVÉES sur le disque (create/delete/change), captent ce que
 * les agents créent directement. Non exhaustif (soumis à files.watcherExclude).
 */
import * as vscode from 'vscode';
import type { Config } from '../config.js';
import type { Emitter } from '../emitter.js';
import { relToWorkspace, currentWorkspaceRoot } from '../workspace.js';
import { log } from '../store/store.js';

interface Pending {
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

export class EditorTracker {
  private pending = new Map<string, Pending>();
  private flushTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private fsWatcher?: vscode.FileSystemWatcher;

  constructor(
    private cfg: Config,
    private emitter: Emitter,
  ) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidRenameFiles((e) => this.onRename(e)),
    );

    this.flushTimer = setInterval(() => void this.flush(), this.cfg.fileEditFlushMs);

    const root = currentWorkspaceRoot();
    if (root) {
      try {
        this.fsWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(root), '**/*'),
        );
        this.fsWatcher.onDidCreate((u) => void this.emitFs(u, 'create'));
        this.fsWatcher.onDidDelete((u) => void this.emitFs(u, 'delete'));
        this.fsWatcher.onDidChange((u) => void this.emitFs(u, 'change'));
      } catch (e) {
        log(`fs watcher failed: ${e}`);
      }
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
      return;
    }
    const key = e.document.uri.fsPath;
    const cur = this.pending.get(key) ?? {
      language: e.document.languageId,
      linesAdded: 0,
      linesRemoved: 0,
    };
    for (const c of e.contentChanges) {
      const added = (c.text.match(/\n/g) ?? []).length;
      const removed = c.range.end.line - c.range.start.line;
      cur.linesAdded += added;
      cur.linesRemoved += removed;
    }
    this.pending.set(key, cur);
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    for (const [fsPath, p] of snapshot) {
      if (p.linesAdded === 0 && p.linesRemoved === 0) {
        continue;
      }
      await this.emitter.emit('file_edit', {
        file: relToWorkspace(fsPath),
        language: p.language,
        linesAdded: p.linesAdded,
        linesRemoved: p.linesRemoved,
      });
    }
  }

  private async emitFs(u: vscode.Uri, kind: 'create' | 'delete' | 'change'): Promise<void> {
    if (u.scheme !== 'file') {
      return;
    }
    const rel = relToWorkspace(u.fsPath);
    if (/(^|\/)(\.git|node_modules|dist|dist-test|\.next|build|coverage)(\/|$)/.test(rel)) {
      return;
    }
    // 'change' est très bavard : on ne garde que create/delete pour le MVP,
    // 'change' est capté via file_edit quand c'est l'utilisateur qui édite.
    if (kind === 'change') {
      return;
    }
    await this.emitter.emit('file_fs', {
      file: rel,
      language: guessLanguage(rel),
      kind,
    });
  }

  private async onRename(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      await this.emitFs(oldUri, 'delete');
      await this.emitFs(newUri, 'create');
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.disposables.forEach((d) => d.dispose());
    this.fsWatcher?.dispose();
    await this.flush();
  }
}

function guessLanguage(rel: string): string {
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    md: 'markdown',
    json: 'json',
    css: 'css',
    scss: 'scss',
    html: 'html',
    prisma: 'prisma',
  };
  return map[ext] ?? ext ?? 'unknown';
}
