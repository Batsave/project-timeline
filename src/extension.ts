import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { readConfig } from './config.js';
import { currentWorkspaceRoot } from './workspace.js';
import { Store, setLogChannel, log } from './store/store.js';
import { Emitter } from './emitter.js';
import { computeRollup } from './core/rollup.js';
import { currentProjectName } from './workspace.js';
import { ActivityTrackerVS } from './tracker/activityTracker.js';
import { AgentsTracker } from './tracker/agentsTracker.js';
import { BackfillRunner } from './tracker/backfillRunner.js';
import { EditorTracker } from './tracker/editorTracker.js';
import { GitTracker } from './tracker/gitTracker.js';
import { TestsTracker } from './tracker/testsTracker.js';
import {
  TaskTracker,
  DebugTracker,
  DiagnosticsTracker,
} from './tracker/miscTrackers.js';
import { StatusBar } from './ui/statusbar.js';
import { Panel } from './ui/panel.js';
import { rollupToMarkdown, rollupToCsv } from './ui/report.js';

interface Runtime {
  dispose(): void | Promise<void>;
}

let runtimes: Runtime[] = [];

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Project Timeline');
  setLogChannel(channel);
  ctx.subscriptions.push(channel);

  const root = currentWorkspaceRoot();
  if (!root) {
    log('aucun workspace ouvert — Project Timeline en veille');
    registerCommands(ctx, null);
    return;
  }

  const cfg = readConfig();
  const store = new Store(ctx);
  await store.init();
  const emitter = new Emitter(store);
  const project = currentProjectName();

  // Backfill à la première ouverture : reconstruit l'historique agents + git.
  try {
    const backfill = new BackfillRunner(ctx, cfg, store, root, project);
    const did = await backfill.runIfNeeded();
    if (did) {
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Project Timeline: history rebuilt from Claude/Codex and git sessions (estimated time).',
        ),
      );
    }
  } catch (e) {
    log(`backfill échoué (non bloquant) : ${e}`);
  }

  const activity = new ActivityTrackerVS(cfg, emitter, store);
  const agents = new AgentsTracker(ctx, cfg, emitter, store, root);
  const editor = new EditorTracker(cfg, emitter);
  const git = new GitTracker(emitter, store);
  const tests = new TestsTracker(emitter);
  const tasks = new TaskTracker(emitter);
  const debug = new DebugTracker(emitter);
  const diagnostics = new DiagnosticsTracker(cfg, emitter);
  const statusBar = new StatusBar(store);
  const panel = new Panel(ctx, store);

  activity.setAgentWriteProbe(() => agents.lastAgentWriteMs());

  await agents.start();
  await activity.start();
  editor.start();
  await git.start();
  tests.start();
  tasks.start();
  debug.start();
  diagnostics.start();
  statusBar.start();

  runtimes = [activity, agents, editor, git, tests, tasks, debug, diagnostics, statusBar, panel];

  registerCommands(ctx, { store, panel });

  log(`Project Timeline actif — projet "${currentProjectName()}", données dans ${store.dataFolder}`);
}

function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: { store: Store; panel: Panel } | null,
): void {
  const cmd = (id: string, fn: () => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('projectTracker.showPanel', async () => {
    if (!deps) return warnNoWorkspace();
    await deps.panel.show();
  });

  cmd('projectTracker.showSummary', async () => {
    if (!deps) return warnNoWorkspace();
    const md = rollupToMarkdown(await buildRollups(deps.store));
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  });

  cmd('projectTracker.exportJson', async () => {
    if (!deps) return warnNoWorkspace();
    const rollups = await buildRollups(deps.store);
    await saveTo('project-tracker.json', JSON.stringify(rollups, null, 2));
  });

  cmd('projectTracker.exportCsv', async () => {
    if (!deps) return warnNoWorkspace();
    const csv = rollupToCsv(await buildRollups(deps.store));
    await saveTo('project-tracker.csv', csv);
  });

  cmd('projectTracker.openDataFolder', async () => {
    if (!deps) return warnNoWorkspace();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(deps.store.dataFolder));
  });

  cmd('projectTracker.recomputeRollups', async () => {
    if (!deps) return warnNoWorkspace();
    await deps.panel.show();
    vscode.window.showInformationMessage(vscode.l10n.t('Project Timeline: rollups recomputed.'));
  });
}

async function buildRollups(store: Store) {
  const events = await store.readAllEvents();
  const project = currentProjectName();
  const now = Date.now();
  return {
    day: computeRollup(events, project, 'day', now),
    week: computeRollup(events, project, 'week', now),
    month: computeRollup(events, project, 'month', now),
    all: computeRollup(events, project, 'all', now),
  };
}

async function saveTo(defaultName: string, content: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, content, 'utf8');
  vscode.window.showInformationMessage(vscode.l10n.t('Exported: {0}', uri.fsPath));
}

function warnNoWorkspace(): void {
  vscode.window.showWarningMessage(vscode.l10n.t('Project Timeline: open a project folder.'));
}

export async function deactivate(): Promise<void> {
  for (const r of runtimes) {
    try {
      await r.dispose();
    } catch (e) {
      log(`dispose failed: ${e}`);
    }
  }
  runtimes = [];
}
