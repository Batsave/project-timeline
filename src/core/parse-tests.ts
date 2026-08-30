/**
 * Reconnaissance d'une commande de test + extraction du résumé depuis la sortie terminal.
 * PURE. Utilisé par tracker/tests.ts (shell integration). EXPÉRIMENTAL par nature :
 * dépend du format de sortie de chaque runner.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
}

const TEST_CMD =
  /\b(vitest|jest|mocha|pytest|ava|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b)/i;

export function looksLikeTestCommand(commandLine: string): boolean {
  return TEST_CMD.test(commandLine);
}

/** Enlève les codes ANSI pour fiabiliser les regex. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/**
 * Essaie plusieurs formats connus. Retourne null si rien de reconnaissable
 * (on ne fabrique pas de chiffres).
 */
export function parseTestOutput(rawOutput: string): TestSummary | null {
  const out = stripAnsi(rawOutput);

  // Vitest / Jest : "Tests  12 passed | 1 failed | 2 skipped (15)"
  //                 "Tests:       12 passed, 1 failed, 15 total"
  // On exige "Tests" en début de ligne (après espaces) et PAS "Test Files".
  const vitest = /^\s*Tests(?!\s+Files)\s*:?\s*([\d ,|a-z]+?)(?:\(\d+\)|\btotal\b|$)/im.exec(out);
  if (vitest) {
    const seg = vitest[1];
    const passed = firstNum(/(\d+)\s+passed/i, seg);
    const failed = firstNum(/(\d+)\s+failed/i, seg);
    const skipped =
      firstNum(/(\d+)\s+skipped/i, seg) + firstNum(/(\d+)\s+todo/i, seg);
    if (passed + failed + skipped > 0) {
      return { passed, failed, skipped };
    }
  }

  // Mocha : "12 passing", "1 failing", "2 pending"
  const mochaPass = firstNum(/(\d+)\s+passing/i, out);
  const mochaFail = firstNum(/(\d+)\s+failing/i, out);
  const mochaPend = firstNum(/(\d+)\s+pending/i, out);
  if (mochaPass + mochaFail + mochaPend > 0) {
    return { passed: mochaPass, failed: mochaFail, skipped: mochaPend };
  }

  // Pytest : "===== 12 passed, 1 failed, 2 skipped in 3.21s ====="
  const pyLine = /=+\s*([^=]+?)\s+in\s+[\d.]+s\s*=+/i.exec(out);
  if (pyLine) {
    const seg = pyLine[1];
    const passed = firstNum(/(\d+)\s+passed/i, seg);
    const failed =
      firstNum(/(\d+)\s+failed/i, seg) + firstNum(/(\d+)\s+error/i, seg);
    const skipped =
      firstNum(/(\d+)\s+skipped/i, seg) +
      firstNum(/(\d+)\s+xfailed/i, seg) +
      firstNum(/(\d+)\s+deselected/i, seg);
    if (passed + failed + skipped > 0) {
      return { passed, failed, skipped };
    }
  }

  // Go : compte les lignes "--- PASS" / "--- FAIL" / "--- SKIP"
  const goPass = countMatches(/^--- PASS/gim, out);
  const goFail = countMatches(/^--- FAIL/gim, out);
  const goSkip = countMatches(/^--- SKIP/gim, out);
  if (goPass + goFail + goSkip > 0) {
    return { passed: goPass, failed: goFail, skipped: goSkip };
  }

  return null;
}

function firstNum(re: RegExp, s: string): number {
  const m = re.exec(s);
  return m ? Number(m[1]) : 0;
}

function countMatches(re: RegExp, s: string): number {
  const m = s.match(re);
  return m ? m.length : 0;
}
