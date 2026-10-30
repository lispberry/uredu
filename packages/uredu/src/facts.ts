// Built-in facts every project has: git history and the task being verified. They read the running
// claim's context, so they're imported like any claim and never listed in deps.
import { current, type Rev } from "./context.ts"

const rev = (ref: string): Rev => ({ kind: "rev", ref })

const matches = (path: string, globs: readonly string[]) => !globs.length || globs.some((g) => new Bun.Glob(g).match(path))

export const git = {
  /** The revision the change is measured from. */
  base: rev("base"),
  /** The change itself (usually a snapshot of the working tree). */
  head: rev("head"),
  mergeBase: (ref: string) => rev(`merge-base:${ref}`),
  ref: (name: string) => rev(`ref:${name}`),
  /** Files changed in base..head under the current part (relative to it), optionally filtered by globs. */
  async changed(...globs: string[]): Promise<string[]> {
    return (await current().engine.changes()).filter((c) => matches(c.path, globs)).map((c) => c.path)
  },
  /** Files added in base..head under the current part (relative to it). */
  async added(...globs: string[]): Promise<string[]> {
    return (await current().engine.changes()).filter((c) => c.status === "added" && matches(c.path, globs)).map((c) => c.path)
  },
  /** Commits in base..head, oldest first. */
  commits: () => current().engine.commits(),
}

export const task = {
  /** Title of the workflow step being verified, if any. */
  get step(): string | undefined {
    return current().engine.step
  },
  get workflow(): string | undefined {
    return current().engine.workflow
  },
}
