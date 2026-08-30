/**
 * Stats RÉTROACTIVES dérivées de l'historique git complet (pas seulement des
 * événements trackés en live depuis l'installation) : composition par langage
 * et fichiers les plus travaillés. Utilise `vscode.git` (repo.log +
 * diffBetweenWithStats), même API que gitTracker/backfillRunner — aucun
 * process `git` lancé directement.
 */
import * as vscode from 'vscode';
import { log } from '../store/store.js';

export interface GitFileStat {
  file: string;
  commits: number;
  insertions: number;
  deletions: number;
  language: string;
}

export interface GitHistoryStats {
  /** ventilation par langage (lignes insérées+supprimées sur tout l'historique). */
  byLanguage: Array<{ language: string; lines: number; pct: number }>;
  /** fichiers les plus modifiés sur tout l'historique, triés par lignes touchées. */
  topFiles: GitFileStat[];
  commitsScanned: number;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  scss: 'scss',
  sass: 'scss',
  css: 'css',
  html: 'html',
  htm: 'html',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  prisma: 'prisma',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shellscript',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
};

export function languageFromPath(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return 'autre';
  const ext = p.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? ext;
}

function changePath(ch: any): string | undefined {
  return ch?.uri?.fsPath ?? ch?.uri?.path ?? ch?.path ?? undefined;
}

/**
 * Parcourt tout l'historique git du repo du workspace courant et agrège
 * lignes/commits par fichier + par langage. Coûteux (un diff par commit) —
 * à appeler seulement à la demande / avec cache côté appelant.
 */
export async function computeGitHistoryStats(
  workspaceRoot: string,
  maxCommits = 2000,
): Promise<GitHistoryStats | null> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return null;
  try {
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    const repo = api.repositories.find(
      (r: any) =>
        workspaceRoot.toLowerCase().startsWith(String(r.rootUri.fsPath).toLowerCase()) ||
        String(r.rootUri.fsPath).toLowerCase().startsWith(workspaceRoot.toLowerCase()),
    );
    if (!repo) return null;

    const commits: any[] = await repo.log({ maxEntries: maxCommits });
    const fileMap = new Map<string, GitFileStat>();
    const langLines = new Map<string, number>();
    let scanned = 0;

    for (const c of commits) {
      const parent = c.parents?.[0];
      if (!parent) continue;
      try {
        const changes: any[] = await repo.diffBetweenWithStats(parent, c.hash);
        for (const ch of changes) {
          const p = changePath(ch);
          if (!p) continue;
          const insertions = ch.insertions ?? 0;
          const deletions = ch.deletions ?? 0;
          const rel = relToRoot(workspaceRoot, p);
          const lang = languageFromPath(rel);
          let fs = fileMap.get(rel);
          if (!fs) {
            fs = { file: rel, commits: 0, insertions: 0, deletions: 0, language: lang };
            fileMap.set(rel, fs);
          }
          fs.commits += 1;
          fs.insertions += insertions;
          fs.deletions += deletions;
          langLines.set(lang, (langLines.get(lang) ?? 0) + insertions + deletions);
        }
        scanned++;
      } catch {
        // commit racine ou diff indisponible pour ce hash — on ignore.
      }
    }

    const totalLangLines = [...langLines.values()].reduce((s, n) => s + n, 0);
    const byLanguage = [...langLines.entries()]
      .map(([language, lines]) => ({
        language,
        lines,
        pct: totalLangLines > 0 ? (lines / totalLangLines) * 100 : 0,
      }))
      .sort((a, b) => b.lines - a.lines);

    const topFiles = [...fileMap.values()]
      .sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions))
      .slice(0, 100);

    return { byLanguage, topFiles, commitsScanned: scanned };
  } catch (e) {
    log(`computeGitHistoryStats échoué : ${e}`);
    return null;
  }
}

function relToRoot(root: string, fsPath: string): string {
  if (fsPath.toLowerCase().startsWith(root.toLowerCase())) {
    return fsPath.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return fsPath.replace(/\\/g, '/');
}
