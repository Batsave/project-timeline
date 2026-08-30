import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Config {
  idleTimeoutMs: number;
  agentGraceMs: number;
  suspendOnScreenLock: boolean;
  minSessionMs: number;
  fileEditFlushMs: number;
  diagnosticsDebounceMs: number;
  claudeProjectsDir: string;
  codexSessionsDir: string;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('projectTracker');
  const claudeDir = c.get<string>('claudeProjectsDir', '').trim();
  const codexDir = c.get<string>('codexSessionsDir', '').trim();
  return {
    idleTimeoutMs: c.get<number>('idleTimeoutMinutes', 10) * 60_000,
    agentGraceMs: c.get<number>('agentGraceMinutes', 3) * 60_000,
    suspendOnScreenLock: c.get<boolean>('suspendOnScreenLock', true),
    minSessionMs: c.get<number>('minSessionSeconds', 30) * 1000,
    fileEditFlushMs: c.get<number>('fileEditFlushSeconds', 60) * 1000,
    diagnosticsDebounceMs: c.get<number>('diagnosticsDebounceSeconds', 30) * 1000,
    claudeProjectsDir: claudeDir || path.join(os.homedir(), '.claude', 'projects'),
    codexSessionsDir: codexDir || path.join(os.homedir(), '.codex', 'sessions'),
  };
}
