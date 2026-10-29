import { rule, git, task, github, code, tests } from "../index.ts"
import { builds, testsPass, newTests, noNewLint, noSkippedTests, output } from "../proofs.ts"

export const buildsAndPasses = rule("Code builds and tests pass", {
  when: git.changed(code),
  uses: { builds, testsPass, noNewLint },
}, ({ expect }) => {
  expect(builds).toPass()
  expect(testsPass).toPass().otherwise(git.bisect)
  expect(noNewLint).toPass()
})

export const honestTests = rule("Tests are never skipped to go green", {
  when: git.changed(tests),
  uses: { noSkippedTests },
}, ({ expect }) => {
  expect(noSkippedTests).toPass()
})

export const regressionTest = rule("Bug fixes carry a regression test", {
  when: task.is("fix").or(github.issue.labeled("bug")),
  uses: { newTests },
  serial: true, // prove the test fails on base before spending time on head
}, ({ expect }) => {
  expect(newTests).at(git.base).toFail()
  expect(newTests).toPass()
})

export const sameBehaviour = rule("Refactors don't change behaviour", {
  when: task.is("refactor"),
  uses: { output },
}, ({ expect }) => {
  expect(output, { workload: "default" }).toMatch(git.base)
})

export const shipSafely = rule("Ship safely", { include: [buildsAndPasses, honestTests, regressionTest] })
