/**
 * Commits via l'API de l'extension Git intégrée (`vscode.git`). AUCUN process lancé
 * par Project Timeline (l'extension Git, elle, invoque `git` en interne — attendu).
 * Git est OBLIGATOIRE (extensionDependencies), pas de fallback.
 */
import * as vscode from 'vscode';
import type { Emitter } from '../emitter.js';
import type { Store } from '../store/store.js';
import { log } from '../store/store.js';
import { commitEventId } from '../core/jsonl.js';

export class GitTracker {
  private cursor: Record<string, string> = {};
  private disposables: vscode.Disposable[] = [];
  private api: any;

  constructor(
    private emitter: Emitter,
    private store: Store,
  ) {}

  async start(): Promise<void> {
    this.cursor = await this.store.loadGitCursor();
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) {
      log('vscode.git introuvable — commits non suivis');
      return;
    }
    const gitExt = ext.isActive ? ext.exports : await ext.activate();
    this.api = gitExt.getAPI(1);

    for (const repo of this.api.repositories) {
      this.hook(repo);
    }
    this.disposables.push(this.api.onDidOpenRepository((r: any) => this.hook(r)));
  }

  private hook(repo: any): void {
    this.publishBranch(repo);
    const d = repo.state.onDidChange(() => {
      this.publishBranch(repo);
      void this.checkNewCommits(repo);
    });
    this.disposables.push(d);
    void this.checkNewCommits(repo);
  }

  private publishBranch(repo: any): void {
    const name: string | undefined = repo.state.HEAD?.name;
    this.emitter.setBranch(name);
  }

  private async checkNewCommits(repo: any): Promise<void> {
    try {
      const head: string | undefined = repo.state.HEAD?.commit;
      const root: string = repo.rootUri.fsPath;
      if (!head || this.cursor[root] === head) {
        return;
      }
      const lastSeen = this.cursor[root];
      const log100: any[] = await repo.log({ maxEntries: 100 });
      const fresh: any[] = [];
      for (const c of log100) {
        if (c.hash === lastSeen) {
          break;
        }
        fresh.push(c);
      }
      // du plus ancien au plus récent
      for (const c of fresh.reverse()) {
        await this.emitCommit(repo, c);
      }
      this.cursor[root] = head;
      await this.store.saveGitCursor(this.cursor);
    } catch (e) {
      log(`checkNewCommits failed: ${e}`);
    }
  }

  private async emitCommit(repo: any, commit: any): Promise<void> {
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    try {
      const parent = commit.parents?.[0];
      if (parent) {
        const changes: any[] = await repo.diffBetweenWithStats(parent, commit.hash);
        filesChanged = changes.length;
        for (const ch of changes) {
          insertions += ch.insertions ?? 0;
          deletions += ch.deletions ?? 0;
        }
      }
    } catch (e) {
      log(`diffBetweenWithStats failed for ${commit.hash}: ${e}`);
    }

    const ts =
      commit.authorDate instanceof Date
        ? commit.authorDate.toISOString()
        : new Date().toISOString();

    await this.emitter.emitAt(
      'commit',
      ts,
      {
        hash: commit.hash,
        message: (commit.message ?? '').split('\n')[0].slice(0, 500),
        author: commit.authorName ?? commit.authorEmail ?? 'unknown',
        branch: repo.state.HEAD?.name ?? '',
        insertions,
        deletions,
        filesChanged,
      },
      commitEventId(commit.hash),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
