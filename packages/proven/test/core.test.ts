import { describe, expect as assert, test } from "bun:test"
import {
  area,
  askHuman,
  builtin,
  claimOf,
  evaluate,
  git,
  github,
  hook,
  http,
  junit,
  not,
  parser,
  preCommit,
  project,
  proofs,
  provide,
  rule,
  sarif,
  script,
  sh,
  task,
  workflow,
  type Facts,
  type Runner,
} from "proven"
import { parseDuration, scopedExpect } from "../src/expect.ts"
import { deterministic, testsPass, output, roundTrips, fuzzClean, bench, newTests } from "proven/proofs"
import { lockstep, replaysUnchanged, frameBudget, sameBehaviour, deterministicSim, safeMessages } from "proven/rules"

const pass = { ok: true, findings: [], artifacts: [] }
const allFacts: Facts = { holds: async () => true, items: async () => ["A"] }
const recording = () => {
  const seen: string[] = []
  const runner: Runner = { run: async (spec) => (seen.push(spec.proof.name), pass) }
  return { seen, runner }
}

describe("areas", () => {
  test("matching, where and added keep the name", () => {
    const a = area("net").matching("src/**").where({ kind: "symbols", toolchain: "rust", query: "derive:X" })
    assert(a).toMatchObject({ name: "net", patterns: ["src/**"], symbols: { query: "derive:X" } })
    assert(a.added("Spawn")).toMatchObject({ kind: "areaChange", area: { name: "net" }, symbol: "Spawn" })
  })
})

describe("facts", () => {
  const a = area("a")
  test("conditions compose", () => {
    const c = git.changed(a).and(task.is("fix")).or(not(github.pr.labeled("x")))
    assert(c.op).toBe("or")
    assert((c.args[0] as { op: string }).op).toBe("and")
    assert(git.diff(git.base, git.head).added(a).op).toBe("git.added")
    assert(git.diff(git.base, git.head).deleted(a).op).toBe("git.deleted")
    assert(git.diff(git.base, git.head).changed(a).op).toBe("git.changed")
    assert(git.commits.mention("faster").op).toBe("git.commits.mention")
    assert(task.declares("x").op).toBe("task.declares")
    assert([github.pr.opened.op, github.issue.linked.op, github.issue.labeled("bug").op]).toEqual([
      "github.pr.opened",
      "github.issue.linked",
      "github.issue.labeled",
    ])
  })
  test("revisions and collections", () => {
    assert([git.mergeBase("main").ref, git.ref("v1").ref, git.step("s").ref, git.step({ id: "t" }).ref]).toEqual([
      "merge-base:main",
      "ref:v1",
      "step:s",
      "step:t",
    ])
    assert(git.log.touching(a).since(git.ref("v1")).op).toBe("git.log")
    assert(askHuman("help")).toEqual({ kind: "fallback", op: "askHuman", args: ["help"] })
  })
})

describe("proofs and instruments", () => {
  test("claims from strings and functions", () => {
    assert(claimOf(testsPass)).toBe("All tests pass")
    assert(claimOf(deterministic, { runs: 3 })).toBe("Replay hash is stable over 3 runs")
    assert(claimOf(output, { workload: "w" })).toBe("Output of w")
    assert(claimOf(bench, { target: "t" })).toBe("Benchmark t")
    assert(claimOf(roundTrips, { message: "m" })).toBe("m encodes and decodes losslessly")
    assert(claimOf(fuzzClean, { target: "f", minutes: 1 })).toBe("f never crashes on hostile input")
  })
  test("instrument constructors and modifiers", () => {
    const i = sh`echo ${1}`.report(junit("j.xml")).value("stdout").samples(parser("bencher")).artifacts("a", "b").findings(parser("cargo-fuzz"))
    assert(i.spec).toMatchObject({ source: { kind: "sh", command: "echo 1" }, report: { kind: "junit" }, value: "stdout", artifacts: ["a", "b"] })
    assert(script("t").spec.source).toEqual({ kind: "script", name: "t" })
    assert(http.get("u").spec.source).toEqual({ kind: "http", method: "GET", url: "u" })
    assert(hook("h").spec.source).toEqual({ kind: "hook", path: "h" })
    assert(preCommit("p").spec.source).toEqual({ kind: "preCommit", id: "p" })
    assert(builtin("b").spec.source).toEqual({ kind: "builtin", name: "b", options: {} })
    assert(sarif("s")).toEqual({ kind: "sarif", path: "s" })
  })
  test("provide rejects a proof bound twice", () => {
    assert(() => provide(area("a"), testsPass.by(sh`a`), testsPass.by(sh`b`))).toThrow("testsPass is bound twice")
  })
  test("project keeps setup and env", () => {
    const p = project({ rules: [], providers: [], setup: sh`bun install`, env: { A: "1" } })
    assert(p).toMatchObject({ kind: "project", env: { A: "1" }, setup: { spec: { source: { command: "bun install" } } } })
    assert(project({ rules: [], providers: [] }).env).toEqual({})
  })
  test("custom proofs", () => {
    const { lint } = proofs({ lint: "Lint is clean" })
    assert(lint).toMatchObject({ kind: "proof", name: "lint" })
    assert(lint.by(sh`x`)).toMatchObject({ kind: "binding", proof: { name: "lint" } })
  })
})

describe("expectations", () => {
  test("durations", () => {
    assert([parseDuration(5), parseDuration("5ms"), parseDuration("2s"), parseDuration("1.5m"), parseDuration("1h")]).toEqual([5, 5, 2000, 90000, 3600000])
    assert(() => parseDuration("soon" as never)).toThrow("invalid duration")
  })
  test("matchers and modifiers", async () => {
    const { runner } = recording()
    const scope = { slots: [], runner, signal: new AbortController().signal, context: { rule: undefined, item: undefined } }
    const expect = scopedExpect<string>(scope)
    expect(testsPass).toPassAt(git.commits)
    expect(output, { workload: "w" }).toMatch(git.base)
    expect(bench, { target: "t" }).toBeFaster(git.base)
    const e = expect(testsPass).at(git.base).toFail().timeout("1s").retry({ max: 2, fix: "fix it" }).otherwise(git.bisect)
    assert(e.spec).toMatchObject({ at: { ref: "base" }, matcher: { kind: "toFail" }, timeoutMs: 1000, retries: { max: 2 } })
    assert(scope.slots.map((s: { spec: { matcher: { kind: string } } }) => s.spec.matcher.kind)).toEqual(["toPassAt", "toMatch", "toBeFaster", "toFail"])
    assert(scope.slots[2]).toMatchObject({ spec: { matcher: { confidence: 0.95, orEqual: false } } })
    assert(await e).toEqual(pass)
    assert(() => e.retry({ max: 1, fix: "x" })).toThrow("modifiers must come before await")
  })
  test("expectations cannot be awaited where nothing runs proofs", () => {
    const scope = { slots: [], runner: undefined, signal: new AbortController().signal, context: { rule: undefined, item: undefined } }
    const e = scopedExpect<string>(scope)(testsPass).toPass()
    assert(() => e.then(() => {})).toThrow("cannot be awaited here")
  })
})

describe("rules", () => {
  test("misuse is rejected", () => {
    assert(() => rule("x", { each: git.diff(git.base, git.head).symbols(area("a")), include: [deterministicSim] })).toThrow("cannot include")
    assert(() => rule("x", {}, () => {})).toThrow("needs `uses`")
    assert(() => rule("x", { uses: { expect: testsPass } }, () => {})).toThrow("`expect` is reserved")
  })
  test("bodies only expect declared proofs", async () => {
    const sneaky = rule("sneaky", { uses: { testsPass } }, ({ expect }) => {
      ;(expect as unknown as (p: typeof newTests) => { toPass(): void })(newTests).toPass()
    })
    await assert(evaluate(sneaky, { facts: allFacts, runner: recording().runner })).rejects.toThrow("not in uses")
  })
  test("context exposes holds, signal and declared proofs", async () => {
    let seen: unknown[] = []
    const r = rule("ctx", { uses: { testsPass }, timeout: "1m" }, async ({ holds, signal, testsPass: p }) => {
      seen = [await holds(task.is("fix")), signal.aborted, p.name]
    })
    await evaluate(r, { facts: allFacts, runner: recording().runner })
    assert(seen).toEqual([true, false, "testsPass"])
  })
  test("waivers skip a rule", async () => {
    const { seen, runner } = recording()
    const result = await evaluate(lockstep, { facts: allFacts, runner, waive: new Map([[deterministicSim, "presentation only"]]) })
    assert(result.children[0]).toMatchObject({ fired: false, waived: "presentation only" })
    assert(seen).not.toContain("deterministic")
  })
  test("shipped rules register what they promise", async () => {
    for (const [r, proofs] of [
      [replaysUnchanged, ["output"]],
      [frameBudget, ["bench"]],
      [sameBehaviour, ["output"]],
      [deterministicSim, ["deterministic"]],
    ] as const) {
      const { seen, runner } = recording()
      await evaluate(r, { facts: allFacts, runner })
      assert(seen).toEqual([...proofs])
    }
    const { seen, runner } = recording()
    await evaluate(safeMessages, { facts: allFacts, runner })
    assert(seen).toEqual(["roundTrips", "fuzzClean"])
  })
})

describe("workflows", () => {
  const p = project({ rules: [], providers: [] })
  test("every step kind, and duplicates are rejected", () => {
    const wf = workflow(p, "All kinds", ({ step, design, fix, refactor, optimize, review }) => {
      const a = design("A")
      fix("B", { after: [a] })
      refactor("C")
      optimize("D")
      step("E")
      review("F")
    })
    assert(wf.steps.map((s) => s.intent)).toEqual(["design", "fix", "refactor", "optimize", "change", "review"])
    assert(() => workflow(p, "Dupes", ({ step }) => (step("Same"), step("same")))).toThrow('duplicate step "same"')
  })
})
