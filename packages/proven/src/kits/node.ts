import { provide, script, builtin, code, tests } from "../index.ts"
import { builds, testsPass, newTests, noNewLint, noSkippedTests } from "../proofs.ts"

export const node = provide(
  [code, tests.matching("**/*.test.*", "**/*.spec.*", "**/__tests__/**")],
  builds.by(script("build")),
  testsPass.by(script("test")),
  // the runner overlays the change's new test files onto the base revision for `.at(git.base)`
  newTests.by(script("test")),
  noNewLint.by(script("lint")),
  noSkippedTests.by(builtin("testInventory", { scan: true })),
)
