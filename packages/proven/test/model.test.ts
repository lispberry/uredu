import { describe, expect as assert, test } from "bun:test"
import { evaluate, walk, type ExpectationSpec, type Facts, type Runner, type Verdict } from "proven"
import { lockstep, shipSafely, safeMessages, regressionTest } from "proven/rules"
import project from "../../../examples/mixed/proven.ts"
import missiles from "../../../examples/mixed/workflows/homing-missiles.ts"

const pass: Verdict = { ok: true, findings: [], artifacts: [] }
const fail: Verdict = { ok: false, findings: [{ message: "boom", severity: "error" }], artifacts: [] }

/** Records runs; `delay` lets tests observe overlap. */
function recorder(verdictFor: (spec: ExpectationSpec) => Verdict = () => pass, delay = 5) {
  const log: string[] = []
  let running = 0
  let maxRunning = 0
  const runner: Runner = {
    async run(spec) {
      const name = `${spec.proof.name}${spec.at ? `@${spec.at.ref}` : ""}`
      running++
      maxRunning = Math.max(maxRunning, running)
      log.push(`start ${name}`)
      await Bun.sleep(delay)
      log.push(`end ${name}`)
      running--
      return verdictFor(spec)
    },
  }
  return { runner, log, maxRunning: () => maxRunning }
}

const facts = (items: unknown[] = [], holds = true): Facts => ({
  holds: async () => holds,
  items: async () => items,
})

describe("rules", () => {
  test("include builds the tree", () => {
    assert([...walk(shipSafely)].map((r) => r.rule.title)).toEqual([
      "Ship safely",
      "Code builds and tests pass",
      "Tests are never skipped to go green",
      "Bug fixes carry a regression test",
    ])
  })

  test("expectations in a rule run in parallel by default", async () => {
    const rec = recorder()
    const result = await evaluate(shipSafely, { facts: facts(), runner: rec.runner })
    const [green] = result.children
    assert(green!.results.map((r) => r.spec.proof.name)).toEqual(["builds", "testsPass", "noNewLint"])
    assert(green!.results[1]!.spec.fallbacks).toEqual([{ kind: "fallback", op: "git.bisect", args: [] }])
    assert(rec.maxRunning()).toBeGreaterThan(3) // across included rules too
  })

  test("serial rules run in order", async () => {
    const rec = recorder()
    await evaluate(regressionTest, { facts: facts(), runner: rec.runner })
    assert(rec.log).toEqual(["start newTests@base", "end newTests@base", "start newTests", "end newTests"])
  })

  test("rules that don't fire run nothing", async () => {
    const rec = recorder()
    const result = await evaluate(lockstep, { facts: facts([], false), runner: rec.runner })
    assert(result.children.every((c) => !c.fired)).toBe(true)
    assert(rec.log).toEqual([])
  })

  test("awaited expectations let a rule decide what to expect next, per item, concurrently", async () => {
    const rec = recorder((spec) => ((spec.args as { message?: string }).message === "Bad" ? fail : pass))
    const result = await evaluate(safeMessages, { facts: facts(["MissileSpawn", "Bad"]), runner: rec.runner })
    const [good, bad] = result.children
    assert(good!.results.map((r) => r.spec.proof.name)).toEqual(["roundTrips", "fuzzClean"])
    assert(good!.results[1]!.spec).toMatchObject({ args: { target: "MissileSpawn", minutes: 30 }, retries: { max: 5 }, timeoutMs: 2_700_000 })
    assert(bad!.results.map((r) => r.spec.proof.name)).toEqual(["roundTrips"])
    assert(rec.log.slice(0, 2)).toEqual(["start roundTrips", "start roundTrips"])
  })
})

describe("example", () => {
  test("project wires providers explicitly", () => {
    assert(project.providers.map((p) => [p.dirs, p.provider.bindings.map((b) => b.proof.name)])).toEqual([
      [["sim", "net", "client"], ["builds", "testsPass", "newTests", "noNewLint", "noSkippedTests"]],
      [["web"], ["builds", "testsPass", "newTests", "noNewLint", "noSkippedTests"]],
      [["sim"], ["deterministic", "output", "bench"]],
      [["net"], ["roundTrips", "fuzzClean"]],
      [["client"], ["bench"]],
      [["web"], ["testsPass"]],
    ])
  })

  test("workflow steps keep order, intent and dependencies", () => {
    assert(missiles.steps.map((s) => [s.id, s.intent, s.after.map((a) => a.id)])).toEqual([
      ["missile-design-is-written", "design", []],
      ["missiles-simulate-correctly", "change", ["missile-design-is-written"]],
      ["missilespawn-travels-over-the-network", "change", ["missile-design-is-written"]],
      ["player-sees-missile-and-lock-on", "change", ["missiles-simulate-correctly", "missilespawn-travels-over-the-network"]],
      ["homing-adds-no-frame-time", "change", ["player-sees-missile-and-lock-on"]],
      ["owner-approves", "review", ["homing-adds-no-frame-time"]],
    ])
    assert(missiles.steps[3]!.skip[0]!.rule.title).toBe("Simulation is deterministic")
    assert(missiles.steps[4]!.done[0]!.spec.proof.name).toBe("bench")
  })
})
