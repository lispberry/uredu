// Proven gates its own repository with the same rules it ships.
import { project, provide, rule, git, sh, builtin, code, tests, proofs } from "proven"
import { shipSafely } from "proven/rules"
import { builds, testsPass, newTests, noNewLint, noSkippedTests } from "proven/proofs"

export const { typeGuarantees } = proofs({
  typeGuarantees: "Compile-time guarantees hold: a project missing a prover does not compile",
})

export const typeLevel = rule("Type-level guarantees hold", { when: git.changed(code), uses: { typeGuarantees } }, ({ expect }) => {
  expect(typeGuarantees).toPass()
})

const repo = provide(
  [code, tests.matching("packages/*/test/**")],
  builds.by(sh`bunx tsc --noEmit -p packages/proven`),
  // bunfig.toml fails the run below 100% line and function coverage
  testsPass.by(sh`bun test`),
  newTests.by(sh`bun test --coverage=false`),
  noNewLint.by(sh`bunx tsc --noEmit -p packages/proven --noUnusedLocals --noUnusedParameters`),
  noSkippedTests.by(builtin("testInventory", { scan: true })),
  typeGuarantees.by(sh`bun run test:types`),
)

export default project({
  rules: [shipSafely, typeLevel],
  providers: [repo.at(".")],
  setup: sh`bun install --frozen-lockfile`,
})
