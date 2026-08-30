/**
 * Rollup -> Markdown / JSON / CSV. Réutilisé par les commandes d'export et le résumé.
 */
import type { Rollup } from '../core/rollup.js';

export function rollupToMarkdown(rollups: Record<string, Rollup>): string {
  const lines: string[] = [];
  const any = Object.values(rollups)[0];
  lines.push(`# Project Timeline — ${any?.project ?? 'projet'}`);
  lines.push('');
  lines.push(
    '> Les dimensions de temps se **chevauchent** : `durée` n\'est pas la somme des autres. ' +
      'Coûts = **estimation** (voir `pricingVersion`). Comptage des tests = expérimental.',
  );
  lines.push('');

  for (const period of ['day', 'week', 'month', 'all'] as const) {
    const r = rollups[period];
    if (!r) continue;
    lines.push(`## ${labelPeriod(period)}`);
    lines.push('');
    lines.push('| Métrique | Valeur |');
    lines.push('|---|---:|');
    lines.push(
      `| Temps suivi | ${fmtDur(r.time.durationMs)}${
        r.time.estimatedMs > 0 ? ` (dont ${fmtDur(r.time.estimatedMs)} estimé) ` : ''
      } |`,
    );
    lines.push(`| dont interaction éditeur | ${fmtDur(r.time.interactionMs)} |`);
    lines.push(`| dont agent actif | ${fmtDur(r.time.agentPresentMs)} |`);
    lines.push(`| dont agent seul (sans frappe) | ${fmtDur(r.time.agentOnlyMs)} |`);
    lines.push(`| dont focus seul / idle | ${fmtDur(r.time.focusOnlyMs)} |`);
    lines.push(`| Sessions | ${r.time.sessions} |`);
    lines.push(`| Session la plus longue | ${fmtDur(r.time.longestSessionMs)} |`);
    lines.push(`| Session médiane | ${fmtDur(r.time.medianSessionMs)} |`);
    lines.push(`| Commits | ${r.git.commits} (+${r.git.insertions} / −${r.git.deletions}) |`);
    lines.push(`| Lignes éditées (éditeur) | +${r.editor.linesAdded} / −${r.editor.linesRemoved} |`);
    lines.push(`| Fichiers créés / supprimés (disque) | ${r.editor.fsCreate} / ${r.editor.fsDelete} |`);
    lines.push(`| Tests | ${r.counts.testsPassed} ✓ / ${r.counts.testsFailed} ✗ sur ${r.counts.testRuns} exécutions |`);
    lines.push(`| Tasks / Debug | ${r.counts.taskRuns} / ${r.counts.debugSessions} |`);
    if (r.quality.firstErrors != null) {
      lines.push(`| Erreurs (début → fin période) | ${r.quality.firstErrors} → ${r.quality.lastErrors} |`);
    }
    lines.push('');

    const agents = Object.entries(r.agents);
    if (agents.length) {
      lines.push('### Agents IA');
      lines.push('');
      for (const [name, a] of agents) {
        lines.push(
          `**${name}** — ${a.sessions} sessions · ${a.turns} tours · ` +
            `${fmtK(a.totalTokens)} tokens · cache hit ${Math.round(a.cacheHitRatio * 100)}% · ` +
            `${a.costEstimateUSD == null ? 'coût n/a' : '$' + a.costEstimateUSD.toFixed(2)} ` +
            `(pricing ${a.pricingVersions.join(', ') || 'n/a'})`,
        );
        if (a.unparsedLines) {
          lines.push(`> ⚠️ ${a.unparsedLines} ligne(s) de session non interprétée(s)`);
        }
        lines.push('');
        lines.push('| Modèle | Tours | In | Out | Cache W | Cache R | Total | Coût |');
        lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
        for (const m of a.byModel) {
          const tot = m.input + m.output + m.cacheCreate + m.cacheRead;
          lines.push(
            `| ${shortModel(m.model)} | ${m.turns} | ${fmtK(m.input)} | ${fmtK(m.output)} | ` +
              `${fmtK(m.cacheCreate)} | ${fmtK(m.cacheRead)} | ${fmtK(tot)} | ` +
              `${m.costEstimateUSD == null ? '—' : '$' + m.costEstimateUSD.toFixed(2)} |`,
          );
        }
        lines.push('');
      }
    }

    if (r.editor.byLanguage.length) {
      lines.push('### Langages travaillés (lignes)');
      lines.push('');
      for (const l of r.editor.byLanguage.slice(0, 12)) {
        lines.push(`- ${l.language} — ${l.pct.toFixed(1)}% (${l.lines} lignes)`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function rollupToCsv(rollups: Record<string, Rollup>): string {
  const rows: string[] = [
    'period,durationMs,interactionMs,agentPresentMs,agentOnlyMs,idleMs,sessions,longestSessionMs,commits,insertions,deletions,linesAdded,linesRemoved,fsCreate,fsDelete,testRuns,testsPassed,testsFailed,taskRuns,debugSessions,claudeTokensIn,claudeTokensOut,claudeCostUSD,codexTokensIn,codexTokensOut,codexCostUSD',
  ];
  for (const [period, r] of Object.entries(rollups)) {
    const c = r.agents.claude;
    const x = r.agents.codex;
    rows.push(
      [
        period,
        r.time.durationMs,
        r.time.interactionMs,
        r.time.agentPresentMs,
        r.time.agentOnlyMs,
        r.time.idleMs,
        r.time.sessions,
        r.time.longestSessionMs,
        r.git.commits,
        r.git.insertions,
        r.git.deletions,
        r.editor.linesAdded,
        r.editor.linesRemoved,
        r.editor.fsCreate,
        r.editor.fsDelete,
        r.counts.testRuns,
        r.counts.testsPassed,
        r.counts.testsFailed,
        r.counts.taskRuns,
        r.counts.debugSessions,
        c?.input ?? 0,
        c?.output ?? 0,
        c?.costEstimateUSD ?? '',
        x?.input ?? 0,
        x?.output ?? 0,
        x?.costEstimateUSD ?? '',
      ].join(','),
    );
  }
  return rows.join('\n');
}

function labelPeriod(p: string): string {
  return { day: "Aujourd'hui", week: '7 jours', month: '30 jours', all: 'Tout' }[p] ?? p;
}

function shortModel(m: string): string {
  const slash = m.lastIndexOf('/');
  if (slash >= 0) return 'local · ' + m.slice(slash + 1);
  return m
    .replace(/^(us|eu|apac)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}$/, '');
}

export function fmtDur(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}

export function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
