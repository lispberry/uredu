// Resolving Rev values (git.base, git.mergeBase("main"), git.step(...)) to commit shas for one evaluation.
import type { Rev } from "../facts.ts"
import { snapshotSubject, type Commit, type Git } from "./git.ts"

export const stepRef = (id: string) => `refs/proven/steps/${id}`

export class Revisions {
  private readonly cache = new Map<string, Promise<string>>()

  constructor(
    readonly git: Git,
    /** sha the change is measured from */
    readonly base: string,
    /** sha of the change itself, usually a working-tree snapshot */
    readonly head: string,
  ) {}

  resolve(rev: Rev): Promise<string> {
    let hit = this.cache.get(rev.ref)
    if (!hit) {
      hit = this.lookup(rev.ref)
      this.cache.set(rev.ref, hit)
    }
    return hit
  }

  /** Commits in base..head, oldest first; a snapshot of uncommitted work is labelled as such. */
  async commits(): Promise<Commit[]> {
    return (await this.git.commits(this.base, this.head)).map((c) =>
      c.sha === this.head && c.subject === snapshotSubject ? { ...c, subject: "uncommitted changes" } : c,
    )
  }

  private async lookup(ref: string): Promise<string> {
    if (ref === "base") return this.base
    if (ref === "head") return this.head
    const [kind, ...rest] = ref.split(":")
    const arg = rest.join(":")
    if (kind === "merge-base") return this.git.mergeBase(await this.git.sha(arg), this.head)
    if (kind === "ref") return this.git.sha(arg)
    if (kind === "step") return this.git.sha(stepRef(arg))
    throw new Error(`unknown revision: ${ref}`)
  }
}
