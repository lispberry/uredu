// Git plumbing. Revisions are resolved to commit shas; the working tree is snapshotted into a commit
// that no branch points at, so runs never see uncommitted edits made after the snapshot.
// Everything Uredu stores lives under <git-dir>/uredu, which git never tracks.
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { proc, procOk } from "./proc.ts"

export type FileStatus = "added" | "modified" | "deleted"

export interface Change {
  readonly path: string
  readonly status: FileStatus
}

/** Subject of the commits Uredu makes for uncommitted work. */
export const snapshotSubject = "uredu snapshot"

export interface Commit {
  readonly sha: string
  readonly subject: string
  readonly body: string
}

export class Git {
  private constructor(
    readonly root: string,
    readonly dir: string,
    /** The index a running `git commit` is about to record (set by git for hooks), if any. */
    readonly hookIndex: string | undefined,
  ) {}

  static async open(cwd: string): Promise<Git> {
    const [root, dir] = (await procOk(["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd })).trim().split("\n")
    const index = process.env.GIT_INDEX_FILE
    return new Git(root!, dir!, index ? resolve(cwd, index) : undefined)
  }

  /** <git-dir>/uredu/<parts> */
  store(...parts: string[]): string {
    return join(this.dir, "uredu", ...parts)
  }

  git(...args: string[]): Promise<string> {
    return procOk(["git", ...args], { cwd: this.root })
  }

  async sha(ref: string): Promise<string> {
    return (await this.git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => {
      throw new Error(`unknown revision: ${ref}`)
    })).trim()
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.git("merge-base", a, b)).trim()
  }

  /** Commit the working tree (tracked and untracked, minus ignored files) on top of `parent`. */
  async snapshot(parent: string): Promise<string> {
    const index = this.store(`index-${process.pid}-${Date.now()}`)
    await mkdir(this.store(), { recursive: true })
    const env = { GIT_INDEX_FILE: index }
    try {
      await procOk(["git", "read-tree", parent], { cwd: this.root, env })
      await procOk(["git", "add", "-A"], { cwd: this.root, env })
      const tree = (await procOk(["git", "write-tree"], { cwd: this.root, env })).trim()
      return this.commitTree(tree, parent)
    } finally {
      await rm(index, { force: true })
    }
  }

  /** Commit the index (what `git commit` would record) on top of `parent`. */
  async snapshotIndex(parent: string): Promise<string> {
    const env = this.hookIndex ? { GIT_INDEX_FILE: this.hookIndex } : undefined
    return this.commitTree((await procOk(["git", "write-tree"], { cwd: this.root, env })).trim(), parent)
  }

  /** Same tree and parent give the same snapshot sha, so verdicts cached for it stay valid. */
  private async commitTree(tree: string, parent: string): Promise<string> {
    if (tree === (await this.git("rev-parse", `${parent}^{tree}`)).trim()) return parent
    const date = (await this.git("show", "-s", "--format=%cI", parent)).trim()
    const env = {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: "uredu",
      GIT_AUTHOR_EMAIL: "uredu@localhost",
      GIT_COMMITTER_NAME: "uredu",
      GIT_COMMITTER_EMAIL: "uredu@localhost",
    }
    return (await procOk(["git", "commit-tree", tree, "-p", parent, "-m", snapshotSubject], { cwd: this.root, env })).trim()
  }

  async diff(a: string, b: string): Promise<Change[]> {
    const out = await this.git("diff", "--name-status", "--no-renames", "-z", a, b)
    const parts = out.split("\0").filter(Boolean)
    const changes: Change[] = []
    for (let i = 0; i < parts.length; i += 2) {
      const status = parts[i] === "A" ? "added" : parts[i] === "D" ? "deleted" : "modified"
      changes.push({ path: parts[i + 1]!, status })
    }
    return changes
  }

  /** Commits in a..b, oldest first. */
  async commits(a: string, b: string): Promise<Commit[]> {
    const out = await this.git("log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${a}..${b}`)
    return out
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, subject, body] = r.split("\x1f")
        return { sha: sha!, subject: subject!, body: body!.trim() }
      })
  }

  async show(sha: string, path: string): Promise<string> {
    return this.git("show", `${sha}:${path}`)
  }

  /** A detached worktree at `sha`, created once and reused. */
  async worktree(sha: string, name = sha): Promise<string> {
    const path = this.store("worktrees", name)
    if (await Bun.file(join(path, ".git")).exists()) return path
    await mkdir(this.store("worktrees"), { recursive: true })
    await this.git("worktree", "add", "--detach", "--force", path, sha)
    return path
  }

  async removeWorktrees(): Promise<void> {
    await rm(this.store("worktrees"), { recursive: true, force: true })
    await proc(["git", "worktree", "prune"], { cwd: this.root })
  }
}
