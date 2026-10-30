import { describe, expect as assert, test } from "bun:test"
import { join } from "node:path"
import { git } from "uredu"
import { Git } from "../src/engine/git.ts"
import { proc, procOk } from "../src/engine/proc.ts"
import { Revisions } from "../src/engine/revs.ts"
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
    assert(g.store("x")).toBe(join(g.dir, "uredu", "x"))
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

    // inside a commit hook git points at the index being committed; Uredu uses it only for the snapshot
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

describe("revisions", () => {
  test("resolve every kind of revision", async () => {
    const r = await repo({ "sim/a.rs": "1" })
    const g = await Git.open(r.root)
    const base = await g.sha("HEAD")
    await r.git("tag", "v1")
    const revs = new Revisions(g, base, base)
    assert(await Promise.all([git.base, git.head, git.mergeBase("main"), git.ref("v1")].map((x) => revs.resolve(x)))).toEqual([base, base, base, base])
    assert(await revs.resolve(git.base)).toBe(base) // cached
    await assert(revs.resolve({ kind: "rev", ref: "weird:x" })).rejects.toThrow("unknown revision: weird:x")
    assert(await revs.commits()).toEqual([])
  })
})
