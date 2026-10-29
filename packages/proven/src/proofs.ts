// The shipped proofs: interfaces only. Kits and projects bind them to tools.
import { proofs } from "./proof.ts"

export const {
  builds,
  testsPass,
  newTests,
  noNewLint,
  noSkippedTests,
  output,
  bench,
  fuzzClean,
  roundTrips,
  deterministic,
  prLinksIssue,
} = proofs({
  builds: "Code builds",
  testsPass: "All tests pass",
  newTests: "The tests added in this change pass",
  noNewLint: "No new lint findings",
  noSkippedTests: "No test was skipped or deleted",
  output: (a: { workload: string }) => `Output of ${a.workload}`,
  bench: (a: { target: string }) => `Benchmark ${a.target}`,
  fuzzClean: (a: { target: string; minutes: number }) => `${a.target} never crashes on hostile input`,
  roundTrips: (a: { message: string }) => `${a.message} encodes and decodes losslessly`,
  deterministic: (a: { runs: number }) => `Replay hash is stable over ${a.runs} runs`,
  prLinksIssue: "The pull request links the issue it resolves",
})
