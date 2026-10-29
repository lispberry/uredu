import { provide, sh, builtin, parser, code, tests, type SymbolMatcher } from "../index.ts"
import { builds, testsPass, newTests, noNewLint, noSkippedTests } from "../proofs.ts"

const provider = provide(
  [code, tests.matching("tests/**", "**/tests/**", "benches/**")],
  builds.by(sh`cargo build --all-targets`),
  testsPass.by(sh`cargo test`),
  // the runner overlays the change's new test files onto the base revision for `.at(git.base)`
  newTests.by(sh`cargo test`),
  noNewLint.by(sh`cargo clippy --all-targets -- -D warnings`),
  noSkippedTests.by(builtin("testInventory", { list: sh`cargo test -- --list --format terse` })),
)

export const cargo = Object.assign(provider, {
  structsDeriving: (derive: string): SymbolMatcher => ({ kind: "symbols", toolchain: "rust", query: `derive:${derive}` }),
  fuzzFindings: parser("cargo-fuzz"),
  criterion: parser("criterion"),
})
