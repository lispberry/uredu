import { describe, expect as assert, test } from "bun:test"
import { join } from "node:path"
import { area, code, git, github, not, project, provide, sh, task, tests } from "proven"
import { testsPass } from "proven/proofs"
import { RepoFacts } from "../src/engine/facts.ts"
import { Git } from "../src/engine/git.ts"
import { inDir, Layout, relative, symbolsIn } from "../src/engine/layout.ts"
import { proc, procOk } from "../src/engine/proc.ts"
import { Revisions, stepRef } from "../src/engine/revs.ts"
import { repo } from "./helpers.ts"

describe("proc", () => {
  test("captures output and fails loudly", async () => {
    assert(await proc(["sh", "-c", "echo out; echo err >&2; exit 3"], { cwd: "/" })).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" })
    assert(await procOk(["sh", "-c", "echo $X"], { cwd: "/", env: { X: "y" } })).toBe("y\n")
    await assert(procOk(["sh", "-c", "echo bad >&2; exit 1"], { cwd: "/" })).rejects.toThrow("failed (1): bad")
  })
})

describe("git", () => {
  test("revisions, snapshots, diffs, commits, worktrees", async () => {
    const r = await repo({ "a.txt": "a\n", "gone.txt": "x\n" })
    const g = await Git.open(join(r.root, "."))
    const head = await g.sha("HEAD")
    assert(g.store("x")).toBe(join(g.dir, "proven", "x"))
    await assert(g.sha("nope")).rejects.toThrow("unknown revision: nope")

    assert(await g.snapshot(head)).toBe(head) // clean tree
    assert(await g.snapshotIndex(head)).toBe(head)
    await r.write({ "a.txt": "changed\n", "new.txt": "n\n" })
    await r.remove("gone.txt")
    const snap = await g.snapshot(head)
    assert(snap).not.toBe(head)
    assert(await g.snapshot(head)).toBe(snap) // deterministic
    assert(await g.diff(head, snap)).toEqual([
      { path: "a.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "new.txt", status: "added" },
    ])
    await r.git("add", "new.txt")
    assert(await g.diff(head, await g.snapshotIndex(head))).toEqual([{ path: "new.txt", status: "added" }])

    // inside a commit hook git points at the index being committed; Proven uses it only for the snapshot
    const other = join(r.root, ".git", "other-index")
    await procOk(["git", "read-tree", head], { cwd: r.root, env: { GIT_INDEX_FILE: other } })
    process.env.GIT_INDEX_FILE = ".git/other-index"
    try {
      const hooked = await Git.open(r.root)
      assert(hooked.hookIndex).toBe(other)
      assert(await hooked.snapshotIndex(head)).toBe(head)
      assert((await proc(["sh", "-c", "echo ${GIT_INDEX_FILE:-unset}"], { cwd: r.root })).stdout).toBe("unset\n")
    } finally {
      delete process.env.GIT_INDEX_FILE
    }

    const c1 = await r.commit("first\n\nwith body")
    await r.git("checkout", "-q", "-b", "feature")
    await r.write({ "b.txt": "b\n" })
    const c2 = await r.commit("second")
    assert((await g.commits(head, c2)).map((c) => [c.sha, c.subject, c.body])).toEqual([
      [c1, "first", "with body"],
      [c2, "second", ""],
    ])
    assert(await g.mergeBase(c1, c2)).toBe(c1)
    assert(await g.show(c2, "b.txt")).toBe("b\n")

    const wt = await g.worktree(c1)
    assert(await Bun.file(join(wt, "a.txt")).text()).toBe("changed\n")
    assert(await g.worktree(c1)).toBe(wt) // reused
    await g.removeWorktrees()
    assert(await Bun.file(join(wt, ".git")).exists()).toBe(false)
  })
})

describe("layout", () => {
  const net = area("net").where({ kind: "symbols", toolchain: "rust", query: "derive:NetMessage" })
  const located = [
    provide([code, tests.matching("tests/**")], testsPass.by(sh`one`)).at("./sim/"),
    provide(net, testsPass.by(sh`two`)).at("net"),
    provide(code, testsPass.by(sh`three`)).at("sim"),
    provide(area("root")).at("."),
  ]
  const layout = new Layout(located)

  test("dirs and globs", () => {
    assert([inDir("sim/a", "sim"), inDir("sim", "sim"), inDir("simx/a", "sim"), inDir("x", ".")]).toEqual([true, true, false, true])
    assert([relative("sim/a/b", "sim"), relative("a", ".")]).toEqual(["a/b", "a"])
    assert(layout.areasOf("sim/tests/t.rs")).toEqual(["code", "tests", "root"])
    assert(layout.areasOf("sim/src/lib.rs")).toEqual(["code", "root"])
    assert(layout.inArea("tests", "sim/src/lib.rs")).toBe(false)
    assert(layout.placementsFor("net", "net/m.rs").map((p) => p.area.symbols?.query)).toEqual(["derive:NetMessage"])
  })

  test("later providers override earlier ones per directory", () => {
    assert(layout.bindings("testsPass").map((b) => [b.dir, b.binding.prover])).toEqual([
      ["sim", located[2]!.provider.bindings[0]!.prover],
      ["net", located[1]!.provider.bindings[0]!.prover],
    ])
  })

  test("rust symbols by derive", () => {
    const src = `
      #[derive(Debug, net::NetMessage)]
      #[serde(tag = "t")]
      pub(crate) struct Spawn { x: u8 }
      #[derive(Clone)] struct Other;
      #[derive(NetMessage)] pub enum Fire { A }
    `
    assert(symbolsIn(src, { kind: "symbols", toolchain: "rust", query: "derive:NetMessage" })).toEqual(["Spawn", "Fire"])
    assert(() => symbolsIn(src, { kind: "symbols", toolchain: "go", query: "derive:X" })).toThrow("unsupported symbol matcher")
  })
})

describe("revisions and facts", async () => {
  const sim = area("simulation")
  const net = area("network message")
  const located = [
    provide(sim).at("sim"),
    provide(net.where({ kind: "symbols", toolchain: "rust", query: "derive:NetMessage" })).at("net"),
    provide(area("plain")).at("plain"),
  ]

  test("resolve every kind of revision", async () => {
    const r = await repo({ "sim/a.rs": "1" })
    const g = await Git.open(r.root)
    const base = await g.sha("HEAD")
    await r.git("update-ref", stepRef("design"), base)
    await r.git("tag", "v1")
    const revs = new Revisions(g, base, base)
    assert(await Promise.all([git.base, git.head, git.mergeBase("main"), git.ref("v1"), git.step("design")].map((x) => revs.resolve(x)))).toEqual([
      base,
      base,
      base,
      base,
      base,
    ])
    assert(await revs.resolve(git.base)).toBe(base) // cached
    await assert(revs.resolve({ kind: "rev", ref: "weird:x" })).rejects.toThrow("unknown revision: weird:x")
    assert(await revs.commits()).toEqual([])
  })

  test("conditions, reasons and collections", async () => {
    const r = await repo({ "sim/a.rs": "1", "net/m.rs": "", "plain/p.txt": "", "gone/x": "1" })
    const g = await Git.open(r.root)
    const base = await g.sha("HEAD")
    await r.write({ "sim/a.rs": "2", "sim/b.rs": "", "sim/c.rs": "", "sim/d.rs": "", "net/m.rs": "#[derive(NetMessage)] struct Spawn;", "plain/p.txt": "x" })
    await r.remove("gone/x")
    await r.commit("faster physics")
    const head = await g.sha("HEAD")
    const layout = new Layout([...located, provide(area("gone")).at("gone")])
    const facts = new RepoFacts({
      git: g,
      layout,
      revs: new Revisions(g, base, head),
      task: { intent: "fix", declares: ["behaviour change"] },
      github: { prOpened: true, prLabels: ["perf"], issueLinked: false, issueLabels: ["bug"] },
    })
    const explain = async (c: Parameters<RepoFacts["explain"]>[0]) => (await facts.explain(c)).reason
    assert(await explain(git.changed(sim))).toBe("git.changed(simulation): sim/a.rs, sim/b.rs, sim/c.rs, +1 more")
    assert(await explain(git.changed(area("nowhere")))).toBe("git.changed(nowhere): nothing")
    assert(await facts.holds(git.diff(git.base, git.head).added(sim))).toBe(true)
    assert(await facts.holds(git.diff(git.base, git.head).deleted(area("gone")))).toBe(true)
    assert(await facts.holds(git.diff(git.base, git.head).deleted(sim))).toBe(false)
    assert(await explain(git.changed(sim).and(not(task.declares("behaviour change"))))).toBe(
      '(git.changed(simulation): sim/a.rs, sim/b.rs, sim/c.rs, +1 more) and (not (task declares "behaviour change"))',
    )
    assert(await facts.holds(task.is("refactor").or(task.is("fix")))).toBe(true)
    assert(await explain(task.declares("nope"))).toBe('task does not declare "nope"')
    assert(await explain(git.commits.mention("Faster"))).toBe('commits mention "faster": 1')
    assert(await Promise.all([github.pr.opened, github.pr.labeled("perf"), github.issue.linked, github.issue.labeled("bug")].map((c) => facts.holds(c)))).toEqual([
      true,
      true,
      false,
      true,
    ])
    assert(await explain(github.pr.labeled("perf"))).toBe('github.pr.labeled("perf"): true')
    await assert(facts.explain({ ...github.pr.opened, op: "github.nope" })).rejects.toThrow("unknown fact: github.nope")

    assert(await facts.items(git.diff(git.base, git.head).symbols(net))).toEqual(["Spawn"])
    assert(await facts.items(git.diff(git.base, git.head).symbols(area("plain")))).toEqual([])
    assert(await facts.items(git.log.touching(sim).since(git.base))).toEqual([{ kind: "rev", ref: `ref:${head}` }])
    assert(await facts.items(git.log.touching(area("nowhere")).since(git.base))).toEqual([])
    await assert(facts.items({ kind: "collection", op: "nope", args: [] })).rejects.toThrow("unknown collection: nope")
  })

  test("without github, and with a forecast", async () => {
    const r = await repo()
    const g = await Git.open(r.root)
    const base = await g.sha("HEAD")
    const facts = new RepoFacts({
      git: g,
      layout: new Layout(located),
      revs: new Revisions(g, base, base),
      task: { intent: "change", declares: [] },
      forecast: { areas: ["simulation"], symbols: { "network message": ["MissileSpawn"] } },
    })
    assert(await facts.explain(github.pr.opened)).toEqual({ value: false, reason: "github.pr.opened: github not available" })
    assert(await facts.explain(git.changed(sim))).toEqual({ value: true, reason: "git.changed(simulation): forecast" })
    assert(await facts.items(git.diff(git.base, git.head).symbols(net))).toEqual(["MissileSpawn"])
    assert(await facts.changedIn("simulation")).toEqual([])
  })

  test("deleted files carry no symbols", async () => {
    const r = await repo({ "net/m.rs": "#[derive(NetMessage)] struct Old;" })
    const g = await Git.open(r.root)
    const base = await g.sha("HEAD")
    await r.remove("net/m.rs")
    const head = await g.snapshot(base)
    const facts = new RepoFacts({ git: g, layout: new Layout(located), revs: new Revisions(g, base, head), task: { intent: "change", declares: [] } })
    assert(await facts.items(git.diff(git.base, git.head).symbols(net))).toEqual([])
    assert(project({ rules: [], providers: located }).providers.length).toBe(3)
  })
})
