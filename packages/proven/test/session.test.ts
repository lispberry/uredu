import { describe, expect as assert, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { main, type IO } from "../src/cli.ts"
import { format } from "../src/engine/format.ts"
import { Git } from "../src/engine/git.ts"
import { claude, installClaude, installPreCommit, preCommit, sessionRef, stopBlockCap } from "../src/engine/hooks.ts"
import { loadProject, Session } from "../src/engine/session.ts"
import { project, proofs, rule } from "../src/index.ts"
import { repo, type Repo } from "./helpers.ts"

const src = resolve(import.meta.dir, "../src/index.ts")

/** A repo whose proven.ts gates on app/ok existing, plus a workflow. */
async function gated(): Promise<Repo> {
  return repo({
    "app/ok": "",
    "app/x": "1",
    "proven.ts": `
      import { project, provide, rule, git, area, proofs, sh } from ${JSON.stringify(src)}
      export const app = area("app")
      export const { healthy, missing } = proofs({ healthy: "app is healthy", missing: "nobody proves this" })
      export const health = rule("App stays healthy", { when: git.changed(app), uses: { healthy } }, ({ expect }) => {
        expect(healthy).toPass()
      })
      export const quiet = rule("Never fires", { when: git.changed(area("nowhere")), uses: { healthy } }, ({ expect }) => {
        expect(healthy).toPass()
      })
      export default project({ rules: [health, quiet], providers: [provide(app, healthy.by(sh\`test -f ok\`)).at("app")] })
    `,
    "flow.ts": `
      import { workflow } from ${JSON.stringify(src)}
      import p, { app, health } from "./proven.ts"
      export default workflow(p, "Flow", ({ step }) => {
        step("Touch app", { expects: [app] })
        step("Skip health", { expects: [app], skip: [{ rule: health, why: "later" }] })
      })
    `,
  })
}

function io(cwd: string, stdin = "") {
  const out: string[] = []
  const err: string[] = []
  const value: IO = { cwd, stdin: async () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) }
  return { value, out, err }
}

describe("session", () => {
  test("loads proven.ts, rejects files without a project", async () => {
    const r = await gated()
    assert((await loadProject(r.root)).kind).toBe("project")
    const bad = await repo({ "proven.ts": "export default 1" })
    await assert(loadProject(bad.root)).rejects.toThrow("must default-export project")
  })

  test("groups and each-rules report their children", async () => {
    const r = await repo({ "net/m.rs": "" })
    const { area, git, project, proofs, provide, rule, sh } = await import("proven")
    const net = area("net")
    const { safe } = proofs({ safe: "message is safe" })
    const each = rule("Every message", { each: git.diff(git.base, git.head).symbols(net), uses: { safe } }, ({ expect }, m) => {
      expect(safe).toPass().timeout(`${m.length}s` as `${number}s`)
    })
    const group = rule("Net", { include: [each] })
    const p = project({
      rules: [group],
      providers: [provide(net.where({ kind: "symbols", toolchain: "rust", query: "derive:Msg" }), safe.by(sh`true`)).at("net")],
    })
    const none = await (await Session.open({ cwd: r.root, project: p })).plan()
    assert(none.rules[0]).toMatchObject({ reason: "always", children: [{ title: "Every message", fired: false, reason: "no items" }] })
    await r.write({ "net/m.rs": "#[derive(Msg)] struct Spawn;" })
    const some = await (await Session.open({ cwd: r.root, project: p })).plan()
    assert(some.rules[0]!.children[0]).toMatchObject({ fired: true, reason: "1 item(s)", children: [{ reason: "for Spawn", item: "Spawn" }] })
  })

  test("head can be an existing revision", async () => {
    const r = await gated()
    const sha = await r.git("rev-parse", "HEAD")
    const s = await Session.open({ cwd: r.root, head: { rev: "HEAD" } })
    assert([s.revs.base, s.revs.head]).toEqual([sha, sha])
  })

  test("plan flags a proof no provider binds", async () => {
    const r = await gated()
    const { check } = proofs({ check: "check" })
    const orphan = rule("orphan", { uses: { check } }, ({ expect }) => {
      expect(check).toPass()
    })
    const plan = await (await Session.open({ cwd: r.root, project: project({ rules: [orphan], providers: [] } as never) })).plan()
    assert(plan.rules[0]!.expectations[0]!.verdict).toMatchObject({ ok: false, planned: true, findings: [{ message: "no provider binds check" }] })
  })
})

describe("format", () => {
  test("plans, passes, failures, waivers", async () => {
    const r = await gated()
    await r.write({ "app/x": "2" })
    const s = await Session.open({ cwd: r.root })
    const planned = format(await s.plan())
    assert(planned).toContain("○ App stays healthy  (git.changed(app): app/x)")
    assert(planned).toContain("    ○ app is healthy — toPass  [app]")
    assert(planned).toContain("· Never fires  (git.changed(nowhere): nothing)")
    assert(planned).toEndWith("1 proof(s) owed")
    assert(format(await s.plan(), { onlyFired: true })).not.toContain("Never fires")

    assert(format(await s.run())).toEndWith("1 passed, 0 failed")
    await r.remove("app/ok")
    const failed = format(await (await Session.open({ cwd: r.root })).run())
    assert(failed).toContain("✗ App stays healthy")
    assert(failed).toContain("error: test -f ok exited with 1")
    assert(failed).toEndWith("0 passed, 1 failed")
  })

  test("locations, reproducers, revisions, missing providers", () => {
    const verdict = (ok: boolean, planned?: boolean) => ({
      ok,
      planned,
      findings: [{ message: "crash", location: { file: "a.rs", line: 3 }, reproducer: "crash-1", severity: "error" as const }, { message: "m", location: { file: "b.rs" }, severity: "note" as const }],
      artifacts: [],
    })
    const text = format({
      base: "a".repeat(40),
      head: "b".repeat(40),
      ok: false,
      runs: [],
      rules: [
        { title: "W", fired: false, reason: "waived: later", waived: "later", expectations: [], children: [] },
        {
          title: "R",
          fired: true,
          reason: "always",
          expectations: [{ proof: "p", claim: "c", matcher: "toFail", at: "base", dirs: [], verdict: verdict(false, true) }],
          children: [],
        },
      ],
    })
    assert(text).toContain("⊘ W  (waived: later)")
    assert(text).toContain("✗ c — toFail at base")
    assert(text).toContain("error: a.rs:3 crash  (reproduce: crash-1)")
    assert(text).toContain("note: b.rs m")
    assert(text).toEndWith("1 proof(s) owed, 1 without a provider")
  })
})

describe("hooks", () => {
  test("pre-commit checks what is staged", async () => {
    const r = await gated()
    assert(await preCommit({ cwd: r.root })).toEqual({ code: 0, stdout: "", stderr: "" })
    await r.remove("app/ok")
    assert((await preCommit({ cwd: r.root })).code).toBe(0) // deletion not staged yet
    await r.git("add", "-A")
    const blocked = await preCommit({ cwd: r.root })
    assert(blocked.code).toBe(1)
    assert(blocked.stderr).toEndWith("commit blocked by proven\n")
  })

  test("a real git commit runs the installed hook", async () => {
    const r = await gated()
    await installPreCommit(await Git.open(r.root), `bun ${resolve(import.meta.dir, "../src/bin.ts")}`)
    await r.write({ "app/x": "2" })
    await r.commit("fine") // passes the gate
    await r.remove("app/ok")
    await assert(r.commit("breaks the app")).rejects.toThrow("commit blocked by proven")
    assert(await r.git("log", "-1", "--format=%s")).toBe("fine")
  })

  test("claude: session start, edits, task completion, stop with a cap", async () => {
    const r = await gated()
    const ev = (name: string) => JSON.stringify({ hook_event_name: name })
    const started = await claude(ev("SessionStart"), { cwd: r.root })
    assert(JSON.parse(started.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" })
    assert(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toStartWith("This repo gates work with proven")
    assert(await r.git("rev-parse", sessionRef)).toBe(await r.git("rev-parse", "HEAD"))

    // the agent commits mid-session: proofs still measure from the session start
    await r.remove("app/ok")
    await r.commit("agent work")
    const edited = await claude(ev("PostToolUse"), { cwd: r.root })
    assert(JSON.parse(edited.stdout).hookSpecificOutput.additionalContext).toContain("App stays healthy")

    const done = await claude(ev("TaskCompleted"), { cwd: r.root })
    assert(done.code).toBe(2)
    assert(done.stderr).toContain("not done; these proofs must pass first")

    for (let i = 0; i < stopBlockCap; i++) assert((await claude(ev("Stop"), { cwd: r.root })).code).toBe(2)
    const handOver = await claude(ev("Stop"), { cwd: r.root })
    assert(handOver.code).toBe(0)
    assert(handOver.stderr).toContain(`after ${stopBlockCap} attempts; a human needs to look`)

    await r.write({ "app/ok": "" })
    assert(await claude(ev("Stop"), { cwd: r.root })).toEqual({ code: 0, stdout: "", stderr: "" })
    assert(await claude(ev("Notification"), { cwd: r.root })).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  test("claude without a session start measures from HEAD", async () => {
    const r = await gated()
    assert((await claude(JSON.stringify({ hook_event_name: "Stop" }), { cwd: r.root })).code).toBe(0)
  })

  test("install: settings merge idempotently, pre-commit hook respects others", async () => {
    const r = await gated()
    await r.write({ ".claude/settings.json": JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }) })
    const path = await installClaude(r.root, "bunx proven")
    await installClaude(r.root, "bunx proven")
    const settings = await Bun.file(path).json()
    assert(settings.model).toBe("x")
    assert(settings.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "other" }] },
      { hooks: [{ type: "command", command: "bunx proven hook claude" }] },
    ])
    assert(settings.hooks.PostToolUse).toEqual([{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "bunx proven hook claude" }] }])
    assert(settings.permissions.deny).toContain("Edit(**/proven.ts)")

    const fresh = await gated()
    assert((await Bun.file(await installClaude(fresh.root, "p")).json()).hooks.SessionStart).toHaveLength(1)

    const git = await Git.open(r.root)
    const hook = await installPreCommit(git, "bunx proven")
    assert(await Bun.file(hook).text()).toContain("exec bunx proven hook pre-commit")
    await installPreCommit(git, "bunx proven") // ours: replaced silently
    await Bun.write(hook, "#!/bin/sh\necho mine\n")
    await assert(installPreCommit(git, "p")).rejects.toThrow("was not written by proven")
    await installPreCommit(git, "p", true)
  })
})

describe("cli", () => {
  test("plan, run, json, workflow steps", async () => {
    const r = await gated()
    await r.write({ "app/x": "2" })
    let t = io(r.root)
    assert(await main(["plan"], t.value)).toBe(0)
    assert(t.out[0]).toContain("App stays healthy")

    t = io(r.root)
    assert(await main(["plan", "--json", "--intent", "fix", "--declare", "behaviour change"], t.value)).toBe(0)
    assert(JSON.parse(t.out[0]!).rules[0].fired).toBe(true)

    t = io(r.root)
    assert(await main(["plan", "--workflow", "flow.ts", "--step", "skip-health"], t.value)).toBe(0)
    assert(t.out[0]).toContain("⊘ App stays healthy  (waived: later)")

    t = io(r.root)
    assert(await main(["plan", "--workflow", "flow.ts", "--step", "nope"], t.value)).toBe(1)
    assert(t.err[0]).toBe("proven: --step must be one of: touch-app, skip-health")

    t = io(r.root)
    assert(await main(["plan", "--intent", "party"], t.value)).toBe(1)
    assert(t.err[0]).toStartWith("proven: --intent must be one of")

    t = io(r.root)
    assert(await main(["run", "--no-cache", "--declare", "a", "--declare", "b"], t.value)).toBe(0)
    await r.remove("app/ok")
    t = io(r.root)
    assert(await main(["run", "--json"], t.value)).toBe(1)
    assert(JSON.parse(t.out[0]!).ok).toBe(false)
  })

  test("hooks and init", async () => {
    const r = await gated()
    let t = io(r.root)
    assert(await main(["hook", "pre-commit"], t.value)).toBe(0)
    await r.remove("app/ok")
    await r.git("add", "-A")
    t = io(r.root)
    assert(await main(["hook", "pre-commit"], t.value)).toBe(1)
    assert(t.err[0]).toContain("commit blocked by proven")

    t = io(r.root, JSON.stringify({ hook_event_name: "SessionStart" }))
    assert(await main(["hook", "claude"], t.value)).toBe(0)
    assert(t.out[0]).toContain("hookSpecificOutput")

    t = io(r.root)
    assert(await main(["hook", "nope"], t.value)).toBe(1)
    assert(t.err[0]).toBe("proven: unknown hook: nope (expected pre-commit or claude)")

    t = io(r.root)
    assert(await main(["init", "--command", "bun x proven"], t.value)).toBe(0)
    const root = await realpath(r.root)
    assert(t.out).toEqual([`wrote ${join(root, ".git", "hooks", "pre-commit")}`, `wrote ${join(root, ".claude", "settings.json")}`])
  })

  test("help and version", async () => {
    const t = io("/")
    assert(await main([], t.value)).toBe(0)
    assert(await main(["bogus"], t.value)).toBe(1)
    assert(await main(["--version"], t.value)).toBe(0)
  })
})
