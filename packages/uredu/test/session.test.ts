import { describe, expect as assert, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { main, type IO } from "../src/cli.ts"
import { Git } from "../src/engine/git.ts"
import { claude, installClaude, installPreCommit, preCommit, sessionRef, stopBlockCap } from "../src/engine/hooks.ts"
import { loadProject } from "../src/engine/session.ts"
import { repo, type Repo } from "./helpers.ts"

const src = resolve(import.meta.dir, "../src/index.ts")

/** A repo whose uredu.ts gates app/ on app/ok existing, plus a workflow. */
async function gated(): Promise<Repo> {
  return repo({
    "app/ok": "",
    "app/x": "1",
    "uredu.ts": `
      import { project, claim, $ } from ${JSON.stringify(src)}
      export const healthy = claim("App is healthy")
      export default project({ claims: [healthy.in("app"), healthy.via(() => $\`test -f ok\`).in("app")] })
    `,
    "flow.ts": `
      import { workflow } from ${JSON.stringify(src)}
      import { healthy } from "./uredu.ts"
      export default workflow("Flow", [], ({ step }) => {
        step("Touch app", [healthy])
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
  test("loads uredu.ts, rejects files without a project", async () => {
    const r = await gated()
    assert((await loadProject(r.root)).claims).toHaveLength(2)
    const bare = await repo({ "uredu.ts": "export default 1" })
    await assert(loadProject(bare.root)).rejects.toThrow("must default-export project({ claims: [...] })")
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
    assert(blocked.stderr).toEndWith("commit blocked by uredu\n")
  })

  test("a real git commit runs the installed hook", async () => {
    const r = await gated()
    await installPreCommit(await Git.open(r.root), `bun ${resolve(import.meta.dir, "../src/bin.ts")}`)
    await r.write({ "app/x": "2" })
    await r.commit("fine") // passes the gate
    await r.remove("app/ok")
    await assert(r.commit("breaks the app")).rejects.toThrow("commit blocked by uredu")
    assert(await r.git("log", "-1", "--format=%s")).toBe("fine")
  })

  test("claude: session start, edits, task completion, stop with a cap", async () => {
    const r = await gated()
    const ev = (name: string) => JSON.stringify({ hook_event_name: name })
    const started = await claude(ev("SessionStart"), { cwd: r.root })
    assert(JSON.parse(started.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" })
    assert(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toStartWith("This repo gates work with uredu")
    assert(await r.git("rev-parse", sessionRef)).toBe(await r.git("rev-parse", "HEAD"))

    // the agent commits mid-session: claims still measure from the session start
    await r.remove("app/ok")
    await r.commit("agent work")
    const edited = await claude(ev("PostToolUse"), { cwd: r.root })
    assert(JSON.parse(edited.stdout).hookSpecificOutput.additionalContext).toContain("App is healthy")

    const done = await claude(ev("TaskCompleted"), { cwd: r.root })
    assert(done.code).toBe(2)
    assert(done.stderr).toContain("not done; these claims must pass first")

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
    const path = await installClaude(r.root, "bunx uredu")
    await installClaude(r.root, "bunx uredu")
    const settings = await Bun.file(path).json()
    assert(settings.model).toBe("x")
    assert(settings.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "other" }] },
      { hooks: [{ type: "command", command: "bunx uredu hook claude" }] },
    ])
    assert(settings.hooks.PostToolUse).toEqual([{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "bunx uredu hook claude" }] }])
    assert(settings.permissions.deny).toContain("Edit(**/uredu.ts)")

    const fresh = await gated()
    assert((await Bun.file(await installClaude(fresh.root, "p")).json()).hooks.SessionStart).toHaveLength(1)

    const git = await Git.open(r.root)
    const hook = await installPreCommit(git, "bunx uredu")
    assert(await Bun.file(hook).text()).toContain("exec bunx uredu hook pre-commit")
    await installPreCommit(git, "bunx uredu") // ours: replaced silently
    await Bun.write(hook, "#!/bin/sh\necho mine\n")
    await assert(installPreCommit(git, "p")).rejects.toThrow("was not written by uredu")
    await installPreCommit(git, "p", true)
  })
})

describe("cli", () => {
  test("plan, run, json, workflow steps", async () => {
    const r = await gated()
    await r.write({ "app/x": "2" })
    let t = io(r.root)
    assert(await main(["plan"], t.value)).toBe(0)
    assert(t.out[0]).toContain("○ App is healthy  [app]  (changed: app/x)")

    t = io(r.root)
    assert(await main(["plan", "--json"], t.value)).toBe(0)
    assert(JSON.parse(t.out[0]!).claims[0].title).toBe("App is healthy")

    t = io(r.root)
    assert(await main(["plan", "--workflow", "flow.ts", "--step", "touch-app"], t.value)).toBe(0)
    assert(t.out[0]).toContain("App is healthy")

    t = io(r.root)
    assert(await main(["plan", "--workflow", "flow.ts", "--step", "nope"], t.value)).toBe(1)
    assert(t.err[0]).toBe("uredu: --step must be one of: touch-app")

    t = io(r.root)
    assert(await main(["run", "--no-cache", "--no-bisect", "--workflow", "flow.ts", "--step", "touch-app"], t.value)).toBe(0)
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
    assert(t.err[0]).toContain("commit blocked by uredu")

    t = io(r.root, JSON.stringify({ hook_event_name: "SessionStart" }))
    assert(await main(["hook", "claude"], t.value)).toBe(0)
    assert(t.out[0]).toContain("hookSpecificOutput")

    t = io(r.root)
    assert(await main(["hook", "nope"], t.value)).toBe(1)
    assert(t.err[0]).toBe("uredu: unknown hook: nope (expected pre-commit or claude)")

    t = io(r.root)
    assert(await main(["init", "--command", "bun x uredu"], t.value)).toBe(0)
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
