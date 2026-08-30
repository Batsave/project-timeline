import * as vscode from 'vscode';
import * as path from 'node:path';

/** Le workspace « courant » suivi : le premier dossier ouvert (MVP mono-projet). */
export function currentWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Nom de projet = basename du dossier racine. */
export function currentProjectName(): string {
  const root = currentWorkspaceRoot();
  return root ? path.basename(root) : 'unknown';
}

export function relToWorkspace(fsPath: string): string {
  const root = currentWorkspaceRoot();
  if (root && fsPath.toLowerCase().startsWith(root.toLowerCase())) {
    return fsPath.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return fsPath.replace(/\\/g, '/');
}
