/**
 * Correspondance projet -> emplacement des sessions d'agents.
 * Aucune dépendance à `vscode` : testable en isolation.
 */

/**
 * Reproduit la règle de Claude Code pour nommer le dossier d'un projet :
 * CHAQUE caractère `:` `\` `/` (et espace) est remplacé par un `-` — sans fusion,
 * donc `:\` produit `--`. Les `-` déjà présents dans les noms sont conservés.
 * Enfin on retire les `-` en tête / queue.
 *
 * Exemples :
 *   `C:\projects\foo`  -> `c--projects-foo`
 *   `C:\My-Project`    -> `c--my-project`
 */
export function projectPathToClaudeSlug(absPath: string): string {
  return absPath
    .replace(/[:\\/ ]/g, '-') // un tiret PAR séparateur, pas de collapse
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .toLowerCase();
}

/** Normalise un chemin pour comparaison (Windows : casse ignorée, séparateurs unifiés). */
export function normalizePathForCompare(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Vrai si `child` est le workspace lui-même ou un sous-dossier.
 * Utilisé pour rattacher une session Codex (dont on connaît le `cwd`) à un workspace.
 */
export function isCwdUnder(workspaceRoot: string, cwd: string): boolean {
  const root = normalizePathForCompare(workspaceRoot);
  const c = normalizePathForCompare(cwd);
  return c === root || c.startsWith(root + '/');
}
