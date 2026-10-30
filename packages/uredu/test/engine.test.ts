import { describe, expect as assert, test } from "bun:test"
import { join } from "node:path"
import { z } from "zod"
import { $, fail, faster, format, git, project, claim, ready, same, Session, task, type Node, type Project } from "uredu"
import { repo, tmp } from "./helpers.ts"

// projects here are often deliberately incomplete, so they skip the compile-time check
const loose = (claims: readonly unknown[], env?: Record<string, string>) => project({ claims, env } as never) as Project

const find = (nodes: readonly Node[], title: string): Node => {
  for (const n of nodes) {
    if (n.title === title) return n
    const hit = n.children.length ? find(n.children, title) : undefined
    if (hit) return hit
  }
  return undefined as never
}
const findIn = (nodes: readonly Node[], title: string): Node | undefined => {
  try {
    return find(nodes, title)
  } catch {
    return undefined
  }
}

describe("plan", () => {
  test("owed claims per part, down to abstract claims, with missing ones flagged", async () => {
    const app = claim("App works")
    const shot = claim("Shot", { screen: z.string() }, z.string())
    const looks = claim("Looks right", async () => void (await shot({ screen: "home" })), [shot])
    const ui = claim("UI", [looks])
    const r = await repo({ "web/a.txt": "1", "docs/x.md": "x" })
    const p = loose([app, ui.in("web"), claim("Docs build").in("docs"), app.via(() => $`true`)])

    await r.write({ "web/a.txt": "2", "README.md": "changed" })
    const plan = await (await Session.open({ cwd: r.root, project: p })).plan()
    assert(plan.planned).toBe(true)
    assert(plan.ok).toBe(false)
    assert(plan.claims.map((n) => [n.title, n.part, n.reason])).toEqual([
      ["App works", ".", "changed: README.md"],
      ["App works", "web", "changed: web/a.txt"],
      ["UI", "web", "changed: web/a.txt"],
    ])
    assert(find(plan.claims, "Shot")).toMatchObject({ status: "missing", findings: ["Shot is not provided in web"] })
    assert(plan.idle).toEqual([{ title: "Docs build", reason: "nothing changed in docs" }])
    assert(format(plan)).toBe(
      [
        `uredu ${plan.base.slice(0, 7)}..${plan.head.slice(0, 7)}`,
        "○ App works  (changed: README.md)",
        "○ App works  [web]  (changed: web/a.txt)",
        "○ UI  [web]  (changed: web/a.txt)",
        "  ○ Looks right",
        "    ✗ Shot",
        "        Shot is not provided in web",
        "· Docs build  (nothing changed in docs)",
        "3 claim(s) owed, 1 not provided",
      ].join("\n"),
    )
    assert(format(plan, { onlyOwed: true })).not.toContain("Docs build")

    const quiet = await (await Session.open({ cwd: r.root, project: loose([app]), head: { rev: "HEAD" } })).plan()
    assert([quiet.ok, quiet.claims, quiet.idle]).toEqual([true, [], [{ title: "App works", reason: "nothing changed" }]])
  })
})

describe("run", () => {
  test("implementations, outputs, schemas and failures", async () => {
    const value = claim("Value", {}, z.string())
    const number = claim("Number", {}, z.number())
    const needs = claim("Needs input", { n: z.number() })
    const broken = claim("Broken")
    const unchanged = claim("Value unchanged", async () => same(await value(), await value.at(git.base)(), "value"), [value])
    const sneaky = claim("Sneaky", async () => void (await value()), [])
    const thrower = claim("Thrower", async () => {
      throw new Error("boom")
    }, [])
    const mustFail = claim("Broken must fail", async () => broken.fails(), [broken])
    const wrongly = claim("Value must fail", async () => value.fails(), [value])
    const unprovided = claim("Unprovided")
    const r = await repo({ "value.txt": "one" })
    const p = loose([
      unprovided,
      value,
      number,
      needs,
      unchanged,
      sneaky,
      thrower,
      mustFail,
      wrongly,
      claim("Group", [value, broken]),
      value.via(() => $`cat value.txt`.text()),
      number.via(() => $`cat value.txt`.text() as never), // deliberately the wrong type
      needs.via(() => $`true`),
      broken.via(() => $`echo nope >&2; exit 1`),
    ])
    await r.write({ "value.txt": "two" })
    const report = await (await Session.open({ cwd: r.root, project: p })).run()
    const status = (t: string) => [find(report.claims, t).status, find(report.claims, t).findings]
    assert(report.planned).toBe(false)
    assert(report.ok).toBe(false)
    assert(status("Value")).toEqual(["passed", []])
    assert(status("Unprovided")).toEqual(["missing", ["Unprovided is not provided in the repo"]])
    assert(status("Number")).toEqual(["failed", ["value: Invalid input: expected number, received string"]])
    assert(status("Needs input")).toEqual(["failed", ["n: Invalid input: expected number, received undefined"]])
    assert(status("Value unchanged")).toEqual(["failed", ['value differs at line 1: "one" → "two"']])
    assert(status("Sneaky")).toEqual(["failed", ['"Sneaky" calls "Value" but doesn\'t list it in its deps']])
    assert(status("Thrower")).toEqual(["failed", ["boom"]])
    assert(status("Broken must fail")).toEqual(["passed", []])
    assert(find(report.claims, "Broken must fail").children[0]).toMatchObject({ status: "passed", fail: true })
    assert(find(report.claims, "Value must fail").children[0]!.findings).toEqual(["expected to fail, but it passed"])
    assert(find(report.claims, "Group").children.map((c) => [c.title, c.status, c.findings])).toEqual([
      ["Value", "passed", []],
      ["Broken", "failed", ["echo nope >&2; exit 1 exited with 1: nope"]],
    ])
    const text = format(report)
    assert(text).toContain('✗ Value unchanged  (changed: value.txt)\n    value differs at line 1: "one" → "two"\n  ✓ Value\n  ✓ Value at base\n')
    assert(text).toContain("✓ Value  (changed: value.txt)")
    assert(text).toContain("✓ Broken must fail  (changed: value.txt)\n✗ Value must fail") // passing claims stay one line
    assert(text).toEndWith("2 passed, 8 failed")
  })

  test("cache, ready, env and logs", async () => {
    const marks = join(await tmp(), "ready.log")
    const greeting = claim("Greeting", {}, z.string())
    const r = await repo({ "a.txt": "1" })
    const p = loose([greeting, greeting.via(() => $`echo $GREETING`.text()), ready.via(() => $`echo ready >> ${marks}`)], { GREETING: "hi" })
    await r.write({ "a.txt": "2" })
    const first = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(first.ok).toBe(true)
    assert(first.runs.map((x) => [x.claim, x.cached])).toEqual([
      ["Worktree is ready", false],
      ["Greeting", false],
    ])
    const id = first.runs[1]!.id
    const session = await Session.open({ cwd: r.root, project: p })
    assert(await Bun.file(session.git.store("runs", id, "log")).text()).toBe("$ echo $GREETING\nhi\n")
    assert(JSON.parse(await Bun.file(session.git.store("runs", id, "run.json")).text())).toMatchObject({ claim: "Greeting", ok: true })

    const second = await session.run()
    assert(second.runs.map((x) => x.cached)).toEqual([true])
    assert(format(second)).toContain("✓ Greeting  (cached, changed: a.txt)")
    assert(find(second.claims, "Greeting").cached).toBe(true)
    const fresh = await (await Session.open({ cwd: r.root, project: p, cache: false })).run()
    assert(fresh.runs.map((x) => x.cached)).toEqual([false])
    assert(await Bun.file(marks).text()).toBe("ready\n") // the worktree was made ready once

    const bad = await repo({ "a.txt": "1" })
    await bad.write({ "a.txt": "2" })
    const failing = await (await Session.open({ cwd: bad.root, project: loose([greeting, greeting.via(() => $`echo x`.text()), ready.via(() => $`exit 7`)]) })).run()
    assert(find(failing.claims, "Greeting").findings[0]).toMatch(/^Worktree is ready failed in .*: exit 7 exited with 7$/)
  })

  test("parts: the most specific implementation wins, and changes are relative to the part", async () => {
    const where = claim("Where", {}, z.string())
    const show = claim("Show", async () => fail(await where(), ...(await git.changed())), [where])
    const r = await repo({ "web/x": "1", "web/admin/y": "1", "z": "1" })
    const p = loose([
      show,
      where.via(() => $`echo first-root`.text()),
      where.via(() => $`echo root`.text()),
      where.via(() => $`echo web; pwd`.text()).in("web"),
      where.via(() => $`echo admin`.text()).in("web/admin"),
    ])
    await r.write({ "web/x": "2", "web/admin/y": "2", "z": "2" })
    const report = await (await Session.open({ cwd: r.root, project: p })).run()
    const byPart = Object.fromEntries(report.claims.map((n) => [n.part, n.findings]))
    assert(byPart["."]).toEqual(["root", "z"])
    assert(byPart["web/admin"]).toEqual(["admin", "y"])
    assert(byPart.web![0]).toMatch(/^web\n.*\/web$/)
    assert(byPart.web![1]).toBe("x")
  })

  test("revisions: new tests overlaid onto base must fail there and pass at head", async () => {
    const tests = claim("Tests", { only: z.array(z.string()) })
    const regression = claim("Regression test", async () => {
      const added = await git.added("t/**")
      await tests.at(git.base, { overlay: added }).fails({ only: added })
      await tests({ only: added })
    }, [tests])
    const r = await repo({ "app/v.txt": "bad" })
    const p = loose([regression.in("app"), tests.via(({ only }) => $`for t in ${only}; do sh "$t" || exit 1; done`).in("app")])
    await r.write({ "app/v.txt": "good", "app/t/check.sh": "grep -q good v.txt" })
    const report = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(report.ok).toBe(true)
    assert(find(report.claims, "Regression test").children.map((c) => [c.title, c.at, c.fail, c.input])).toEqual([
      ["Tests", "base", true, { only: ["t/check.sh"] }],
      ["Tests", undefined, undefined, { only: ["t/check.sh"] }],
    ])
    assert(format(report)).toContain("✓ Regression test  [app]")

    await r.write({ "app/v.txt": "bad" }) // the fix is gone: the new test fails at head too
    const broken = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(format(broken)).toContain('  ✓ Tests {"only":["t/check.sh"]} at base  (must fail, cached)\n  ✗ Tests {"only":["t/check.sh"]}\n')
  })

  test("failures are bisected across commits", async () => {
    const ok = claim("Ok")
    const r = await repo({ ok: "" })
    const base = await r.git("rev-parse", "HEAD")
    const p = loose([ok, ok.via(() => $`test -f ok`)])
    await r.write({ "a.txt": "1" })
    await r.commit("harmless")
    await r.remove("ok")
    const bad = await r.commit("breaks it")
    await r.write({ "b.txt": "1" })
    await r.commit("later")
    const report = await (await Session.open({ cwd: r.root, project: p, base })).run()
    assert(report.claims[0]!.findings).toEqual(["test -f ok exited with 1", `bisect: first failing ${bad.slice(0, 7)} "breaks it"`])
    const plain = await (await Session.open({ cwd: r.root, project: p, base, bisect: false })).run()
    assert(plain.claims[0]!.findings).toEqual(["test -f ok exited with 1"])
  })

  test("facts: added files, commits, the task", async () => {
    const facts = claim("Facts", async () => fail(await git.added(), (await git.commits()).map((c) => c.subject), task.step ?? "-", task.workflow ?? "-"), [])
    const r = await repo()
    const base = await r.git("rev-parse", "HEAD")
    await r.write({ "new.txt": "1" })
    await r.commit("add new")
    const report = await (await Session.open({ cwd: r.root, project: loose([facts]), base })).run()
    assert(report.claims[0]!.findings).toEqual(["new.txt", "add new", "-", "-"])
  })

  test("timings: head must not be confidently slower", async () => {
    const timing = claim("Timing", {}, z.array(z.number()))
    const fast = claim("Fast enough", async () => faster(timing, {}, git.base, { rounds: 3 }), [timing])
    const r = await repo({ "t.json": "[10, 11, 10]" })
    const p = loose([fast, timing.via(() => $`cat t.json`.json())])
    await r.write({ "t.json": "[20, 21, 20]" })
    const slow = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(slow.claims[0]!.findings).toEqual(["96.8% slower than base (confidence 1.000)"])
    assert(slow.runs.every((x) => !x.cached)).toBe(true)
    await r.write({ "t.json": "[5, 6, 5]" })
    assert((await (await Session.open({ cwd: r.root, project: p })).run()).ok).toBe(true)

    const single = claim("Single", {}, z.number())
    const p2 = loose([claim("Fast single", async () => faster(single, {}, git.base), [single]), single.via(() => $`cat n`.json())])
    const r2 = await repo({ n: "1" })
    await r2.write({ n: "1 " })
    assert((await (await Session.open({ cwd: r2.root, project: p2 })).run()).ok).toBe(true)
  })
})

describe("workflow steps", () => {
  test("a step owes its claims and the workflow's, where they're implemented", async () => {
    const shot = claim("Shot")
    const lint = claim("Lint")
    const said = claim("Said", async () => fail(`${task.workflow}: ${task.step}`), [])
    const r = await repo({ "web/a": "1" })
    const p = loose([shot.via(() => $`true`).in("web"), lint.via(() => $`true`)])
    const flow = {
      kind: "workflow" as const,
      title: "Flow",
      claims: [lint],
      steps: [{ kind: "step" as const, id: "s", title: "Screens", claims: [claim("UI", [shot]), said], after: [], produces: [] }],
    }
    const target = { workflow: flow, step: flow.steps[0]! }
    const session = await Session.open({ cwd: r.root, project: p })
    const plan = await session.plan(target)
    assert(plan.claims.map((n) => [n.title, n.part, n.reason])).toEqual([
      ["Lint", ".", 'step "Screens"'],
      ["UI", "web", 'step "Screens"'],
      ["Said", ".", 'step "Screens"'],
    ])
    const run = await session.run(target)
    assert(find(run.claims, "Said").findings).toEqual(["Flow: Screens"])
    assert(findIn(run.claims, "Nope")).toBeUndefined()

    await r.write({ "web/a": "2" })
    const touched = await (await Session.open({ cwd: r.root, project: p })).plan(target)
    assert(touched.claims.map((n) => [n.title, n.part])).toEqual([
      ["Lint", "web"],
      ["UI", "web"],
      ["Said", "web"],
    ])
  })
})
