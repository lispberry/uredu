import { describe, expect as assert, test } from "bun:test"
import { expect } from "bun:test"
import { area, askHuman, builtin, code, git, parser, project, proofs, provide, rule, sh, tests, workflow, type Project } from "proven"
import { newTests, noSkippedTests } from "proven/proofs"
import { Session, type ExpectationReport, type Report, type RuleReport } from "../src/engine/session.ts"
import { ProofRunner, ruleAreas, targets } from "../src/engine/runner.ts"
import { repo, type Repo } from "./helpers.ts"

const { check, out, speed, slow } = proofs({
  check: "app is healthy",
  out: "app output",
  speed: "app speed",
  slow: "never finishes",
})
const app = area("app")

const flat = (r: Report): ExpectationReport[] => r.rules.flatMap(function all(x: RuleReport): ExpectationReport[] {
  return [...x.expectations, ...x.children.flatMap(all)]
})

const appProvider = provide(
  [app, code, tests.matching("tests/**")],
  check.by(sh`test -f ok`),
  out.by(sh`cat value.txt`.value("stdout")),
  speed.by(sh`cat speed.txt`.samples(parser("bencher"))),
  slow.by(sh`sleep 5`),
  newTests.by(sh`for t in tests/*.sh; do sh "$t" || exit 1; done`),
  noSkippedTests.by(builtin("testInventory", { scan: true })),
)

async function fixture(): Promise<Repo> {
  return repo({ "app/ok": "", "app/value.txt": "1", "app/speed.txt": "bench: 100 ns/iter", "app/tests/old.sh": "exit 0", "app/impl": "v1" })
}

const run = async (r: Repo, p: Project, base = "HEAD", extra: Partial<Parameters<typeof Session.open>[0]> = {}) =>
  (await Session.open({ cwd: r.root, project: p, base, ...extra })).run()

describe("runner", () => {
  test("toPass, bisect and askHuman fallbacks", async () => {
    const r = await fixture()
    const base = await r.git("rev-parse", "HEAD")
    await r.write({ "app/impl": "v2" })
    await r.commit("harmless")
    await r.remove("app/ok")
    await r.commit("breaks health")
    await r.write({ "app/impl": "v3" })
    const healthy = rule("App stays healthy", { when: git.changed(app), uses: { check } }, ({ expect }) => {
      expect(check).toPass().otherwise(git.bisect).otherwise(askHuman("health is broken"))
    })
    const report = await run(r, project({ rules: [healthy], providers: [appProvider.at("app")] }), base)
    assert(report.ok).toBe(false)
    const [e] = flat(report)
    assert(e!.dirs).toEqual(["app"])
    assert(e!.verdict.findings.map((f) => f.message)).toEqual([
      expect.stringContaining("test -f ok exited with 1") as unknown as string,
      expect.stringMatching(/^bisect: first failing [0-9a-f]{7} "breaks health"$/) as unknown as string,
      "ask a human: health is broken",
    ])
    assert(report.runs.length).toBeGreaterThan(1)
  })

  test("bisect blames uncommitted changes", async () => {
    const r = await fixture()
    await r.remove("app/ok")
    const healthy = rule("healthy", { uses: { check } }, ({ expect }) => {
      expect(check).toPass().otherwise(git.bisect)
    })
    const [e] = flat(await run(r, project({ rules: [healthy], providers: [appProvider.at("app")] })))
    assert(e!.verdict.findings.at(-1)!.message).toMatch(/"uncommitted changes"$/)
  })

  test("regression tests: fail on base with the new tests overlaid, pass on head", async () => {
    const r = await fixture()
    await r.write({ "app/tests/new.sh": 'grep -q fixed impl', "app/impl": "fixed" })
    const regression = rule("Bug fixes carry a regression test", { uses: { newTests }, serial: true }, ({ expect }) => {
      expect(newTests).at(git.base).toFail()
      expect(newTests).toPass()
    })
    const p = project({ rules: [regression], providers: [appProvider.at("app")] })
    const report = await run(r, p)
    assert(flat(report).map((e) => e.verdict.ok)).toEqual([true, true])
    assert(report.ok).toBe(true)

    // a test that already passes on base is not a regression test
    const r2 = await fixture()
    await r2.write({ "app/tests/new.sh": "exit 0" })
    const [onBase] = flat(await run(r2, p))
    assert(onBase!.verdict.findings[0]!.message).toMatch(/expected to fail at [0-9a-f]{7}, but it passed/)
  })

  test("toMatch compares values across revisions", async () => {
    const r = await fixture()
    const same = rule("Output is unchanged", { uses: { out, check } }, ({ expect }) => {
      expect(out).toMatch(git.base)
      expect(check).toMatch(git.base)
    })
    const p = project({ rules: [same], providers: [appProvider.at("app")] })
    await r.write({ "app/impl": "refactored" })
    const [match, noValue] = flat(await run(r, p))
    assert(match!.verdict).toMatchObject({ ok: true, value: "1" })
    assert(noValue!.verdict.findings[0]!.message).toBe("check has no value to compare; give its prover .value(...)")

    await r.write({ "app/value.txt": "2" })
    assert(flat(await run(r, p))[0]!.verdict.findings[0]!.message).toMatch(/^app output differs from [0-9a-f]{7}$/)
    await r.remove("app/value.txt")
    assert(flat(await run(r, p))[0]!.verdict.ok).toBe(false)
  })

  test("toBeFaster interleaves runs and compares samples", async () => {
    const r = await fixture()
    const faster = rule("Faster", { uses: { speed } }, ({ expect }) => {
      expect(speed).toBeFaster(git.base)
    })
    const noWorse = rule("No worse", { uses: { speed } }, ({ expect }) => {
      expect(speed).toBeFaster(git.base, { orEqual: true })
    })
    const providers = [appProvider.at("app")]
    await r.write({ "app/speed.txt": "bench: 50 ns/iter" })
    const [fast] = flat(await run(r, project({ rules: [faster], providers }), "HEAD", { rounds: 3 }))
    assert(fast!.verdict).toMatchObject({ ok: true, value: { baseMean: 100, headMean: 50, confidence: 1 } })

    await r.write({ "app/speed.txt": "bench: 100 ns/iter" })
    const [equal, equalOk] = flat(await run(r, project({ rules: [faster, noWorse], providers }), "HEAD", { rounds: 2 }))
    assert(equal!.verdict.findings[0]!.message).toMatch(/^speed: head 0\.0% vs [0-9a-f]{7} \(confidence faster 0\.500\)$/)
    assert(equalOk!.verdict.ok).toBe(true)

    await r.write({ "app/speed.txt": "no numbers" })
    assert(flat(await run(r, project({ rules: [faster], providers })))[0]!.verdict.findings[0]!.message).toBe(
      "speed produced no samples; give its prover .samples(...)",
    )
    await r.remove("app/speed.txt")
    assert(flat(await run(r, project({ rules: [faster], providers })))[0]!.verdict.ok).toBe(false)
  })

  test("toPassAt runs every commit", async () => {
    const r = await fixture()
    const base = await r.git("rev-parse", "HEAD")
    await r.remove("app/ok")
    await r.commit("broken")
    await r.write({ "app/ok": "" })
    await r.commit("fixed")
    const every = rule("Every commit is healthy", { uses: { check } }, ({ expect }) => {
      expect(check).toPassAt(git.commits)
    })
    const [e] = flat(await run(r, project({ rules: [every], providers: [appProvider.at("app")] }), base))
    assert(e!.verdict.ok).toBe(false)
    assert(e!.verdict.findings.length).toBe(1)
    assert(e!.verdict.findings[0]!.message).toMatch(/^[0-9a-f]{7}: test -f ok exited with 1/)
    await r.write({ "app/impl": "dirty" }) // head snapshot becomes its own revision
    const [e2] = flat(await run(r, project({ rules: [every], providers: [appProvider.at("app")] }), base))
    assert(e2!.verdict.findings.length).toBe(1)
  })

  test("test inventory: scanned and listed", async () => {
    const r = await repo({ "app/a.test.ts": 'test("a", () => {})\ntest("b", () => {})', "lst/x": "" })
    const inventory = rule("Honest tests", { uses: { noSkippedTests } }, ({ expect }) => {
      expect(noSkippedTests).toPass()
      expect(noSkippedTests).at(git.base).toPass()
    })
    const scan = provide([code, tests.matching("**/*.test.ts")], noSkippedTests.by(builtin("testInventory", { scan: true })))
    const p = project({ rules: [inventory], providers: [scan.at("app")] })
    await r.write({ "app/a.test.ts": 'test("a", () => {})\ntest.skip("b", () => {})' })
    const [skipped, onBase] = flat(await run(r, p))
    assert(skipped!.verdict.findings.map((f) => f.message)).toEqual(["skipped tests went from 0 to 1"])
    assert(onBase!.verdict.ok).toBe(true)
    await r.write({ "app/a.test.ts": 'test("a", () => {})' })
    assert(flat(await run(r, p))[0]!.verdict.findings.map((f) => f.message)).toEqual(["tests went from 2 to 1"])

    const listed = provide(code, noSkippedTests.by(builtin("testInventory", { list: sh`cat list` })))
    const lp = project({ rules: [inventory], providers: [listed.at("lst")] })
    await r.write({ "lst/list": "a: test\nb: test\n" })
    await r.commit("list")
    await r.write({ "lst/list": "a: test\n" })
    assert(flat(await run(r, lp))[0]!.verdict.findings.map((f) => f.message)).toEqual(["tests went from 2 to 1"])
    await r.remove("lst/list")
    assert(flat(await run(r, lp))[0]!.verdict.findings[0]!.message).toMatch(/^listing tests failed at [0-9a-f]{7}: cat list exited with 1/)

    const bogus = provide(code, noSkippedTests.by(builtin("nope")))
    const [unknown] = flat(await run(r, project({ rules: [inventory], providers: [bogus.at("lst")] })))
    assert(unknown!.verdict.findings[0]!.message).toBe('builtin "nope" is not implemented')
  })

  test("caching, timeouts, missing providers, several directories", async () => {
    const r = await fixture()
    await r.write({ "two/ok": "", "app/impl": "v2", "two/impl": "x" })
    const healthy = rule("healthy", { when: git.changed(app), uses: { check } }, ({ expect }) => {
      expect(check).toPass()
    })
    const p = project({ rules: [healthy], providers: [appProvider.at("app", "two")] })
    const first = await run(r, p)
    assert(flat(first)[0]!.dirs).toEqual(["app", "two"])
    assert(first.runs.every((x) => !x.cached)).toBe(true)
    const second = await run(r, p)
    assert(second.runs.every((x) => x.cached)).toBe(true)
    assert((await run(r, p, "HEAD", { cache: false })).runs.every((x) => !x.cached)).toBe(true)

    await r.remove("two/ok")
    const split = flat(await run(r, p))[0]!.verdict
    assert(split).toMatchObject({ ok: false, value: { app: undefined, two: undefined } })
    assert(split.findings[0]!.message).toStartWith("[two] ")

    const timed = rule("slow", { uses: { slow } }, ({ expect }) => {
      expect(slow).toPass().timeout("50ms")
    })
    assert(flat(await run(r, project({ rules: [timed], providers: [appProvider.at("app")] })))[0]!.verdict.ok).toBe(false)

    const orphan = rule("orphan", { uses: { check } }, ({ expect }) => {
      expect(check).toPass()
    })
    const none = flat(await run(r, project({ rules: [orphan], providers: [] } as never)))[0]!
    assert(none.verdict.findings[0]!.message).toBe('no provider binds check for "orphan"')
  })

  test("setup runs once per worktree and env reaches provers", async () => {
    const r = await fixture()
    const { envSeen } = proofs({ envSeen: "env" })
    const p = provide(app, envSeen.by(sh`test "$MODE" = ci && test -f ../installed`))
    const healthy = rule("env", { uses: { envSeen } }, ({ expect }) => {
      expect(envSeen).toPass()
      expect(envSeen).at(git.base).toPass()
    })
    const report = await run(r, project({ rules: [healthy], providers: [p.at("app")], setup: sh`touch installed`, env: { MODE: "ci" } }))
    assert(report.ok).toBe(true)
    await r.write({ x: "dirty" })
    const failing = project({ rules: [healthy], providers: [p.at("app")], setup: sh`exit 9` })
    await assert(run(r, failing)).rejects.toThrow("setup failed")
  })

  test("areas a rule is about", () => {
    const a = area("a")
    const b = area("b")
    assert(ruleAreas(undefined)).toEqual([])
    assert(ruleAreas(rule("x", { when: git.changed(a).and(git.changed(b)).or(task.is("fix")) }))).toEqual(["a", "b"])
    assert(ruleAreas(rule("x", { each: git.diff(git.base, git.head).symbols(a) }))).toEqual(["a"])
    assert(ruleAreas(rule("x", { each: git.log.touching(b).since(git.base) }))).toEqual(["b"])
    assert(typeof ProofRunner).toBe("function")
    assert(typeof targets).toBe("function")
  })

  test("workflow steps add expectations and waive rules", async () => {
    const r = await fixture()
    const healthy = rule("healthy", { when: git.changed(app), uses: { check } }, ({ expect }) => {
      expect(check).toPass()
    })
    const p = project({ rules: [healthy], providers: [appProvider.at("app")] })
    const wf = workflow(p, "wf", ({ step, expect }) => {
      step("Touches app", { expects: [app], done: [expect(out).toPass()] })
      step("Skips health", { expects: [app.added("Thing")], skip: [{ rule: healthy, why: "not yet" }] })
    })
    const session = await Session.open({ cwd: r.root, project: p })
    const touches = await session.planStep(wf, wf.steps[0]!)
    assert(touches.rules.map((x) => [x.title, x.fired, x.reason])).toEqual([
      ["healthy", true, "git.changed(app): forecast"],
      ["Step expectations", true, "declared by the step"],
    ])
    const skips = await session.planStep(wf, wf.steps[1]!)
    assert(skips.rules[0]).toMatchObject({ fired: false, waived: "not yet", reason: "waived: not yet" })
    const other = workflow(p, "other", ({ step }) => void step("x"))
    await assert(session.planStep(wf, other.steps[0]!)).rejects.toThrow('step "x" is not in workflow "wf"')
    const ran = await session.run({ extra: wf.steps[0]!.done })
    assert(ran.rules.at(-1)!.expectations[0]!.verdict.ok).toBe(true)
  })
})

import { task } from "proven"
