// Ship safely: the baseline every change owes. Portable: no languages, tools or paths. Projects provide
// build, tests, lint and testInventory (or spread a kit from "@uredu/ship-safely/kits").
import { z } from "zod"
import { claim, git, fail } from "uredu"

export const build = claim("Build")
/** Runs the tests; `only` narrows it to these files (relative to the part). */
export const tests = claim("Tests", { only: z.array(z.string()).optional() })
export const lint = claim("Lint")
export const testInventory = claim("Test inventory", {}, { tests: z.number(), skipped: z.number() })

/** Where tests usually live, across ecosystems. */
export const testFiles = ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**", "**/test_*.py", "**/*_test.py", "**/*_test.go"]

export const buildsAndPasses = claim("Code builds and tests pass", async () => {
  if (!(await git.changed()).length) return
  await Promise.all([build(), tests(), lint()])
}, [build, tests, lint])

export const honestTests = claim("Tests are never skipped or deleted to go green", async () => {
  if (!(await git.changed(...testFiles)).length) return
  const [now, before] = await Promise.all([testInventory(), testInventory.at(git.base)()])
  if (now.tests < before.tests) fail(`tests went from ${before.tests} to ${now.tests}`)
  if (now.skipped > before.skipped) fail(`skipped tests went from ${before.skipped} to ${now.skipped}`)
}, [testInventory])

export const regressionTest = claim("Bug fixes carry a regression test", async () => {
  const added = await git.added(...testFiles)
  if (!added.length) fail("a fix needs a new test that fails before the fix and passes after it")
  await tests.at(git.base, { overlay: added }).fails({ only: added })
  await tests({ only: added })
}, [tests])

export const shipSafely = claim("Ship safely", [buildsAndPasses, honestTests])
export const regression = claim("Regression", [regressionTest])
