// A session proves one change: base..head, where head is a snapshot of the working tree (or of the index,
// for pre-commit). It works out what the change owes in each part of the repo, then `plan` shows that
// without running anything and `run` runs it.
import { join } from "node:path"
import type { Node } from "../context.ts"
import type { AnyClaim } from "../claim.ts"
import type { Project } from "../project.ts"
import type { Step, Workflow } from "../workflow.ts"
import { Git, type Change } from "./git.ts"
import { Revisions } from "./revs.ts"
import { inPath, Runner, type RunRecord } from "./runner.ts"

export interface SessionOptions {
  readonly cwd: string
  /** Project to prove; defaults to the default export of <repo>/uredu.ts. */
  readonly project?: Project
  /** Revision the change is measured from. Default: HEAD. */
  readonly base?: string
  /** What head is: the working tree (default), the index (pre-commit) or an existing revision. */
  readonly head?: "worktree" | "index" | { readonly rev: string }
  readonly cache?: boolean
  /** Bisect failing calls when base..head holds more than one commit. Default: true. */
  readonly bisect?: boolean
}

/** A claim owed in one part of the repo, and why. */
export interface Owed {
  readonly claim: AnyClaim
  readonly part: string
  readonly reason: string
}

export interface Report {
  readonly base: string
  readonly head: string
  readonly ok: boolean
  /** True for `plan`: nothing ran. */
  readonly planned: boolean
  readonly claims: readonly (Node & { readonly reason: string })[]
  /** Owed entries the change doesn't touch. */
  readonly idle: readonly { readonly title: string; readonly reason: string }[]
  readonly runs: readonly RunRecord[]
}

export interface Target {
  readonly workflow: Workflow
  readonly step: Step
}

export async function loadProject(root: string): Promise<Project> {
  const mod = (await import(join(root, "uredu.ts"))) as { default?: Project }
  if (mod.default?.kind !== "project") throw new Error(`${join(root, "uredu.ts")} must default-export project({ claims: [...] })`)
  return mod.default
}

const list = (paths: readonly string[]) => (paths.length > 3 ? `${paths.slice(0, 3).join(", ")}, +${paths.length - 3} more` : paths.join(", "))
const where = (part: string) => (part === "." ? "the repo" : part)

export class Session {
  private constructor(
    readonly git: Git,
    readonly project: Project,
    readonly revs: Revisions,
    readonly changes: readonly Change[],
    readonly options: SessionOptions,
  ) {}

  static async open(options: SessionOptions): Promise<Session> {
    const git = await Git.open(options.cwd)
    const project = options.project ?? (await loadProject(git.root))
    const base = await git.sha(options.base ?? "HEAD")
    const head = options.head ?? "worktree"
    // snapshots sit on top of HEAD, so base..head includes every commit since base plus uncommitted work
    const headSha =
      head === "worktree" ? await git.snapshot(await git.sha("HEAD")) : head === "index" ? await git.snapshotIndex(await git.sha("HEAD")) : await git.sha(head.rev)
    return new Session(git, project, new Revisions(git, base, headSha), await git.diff(base, headSha), options)
  }

  /** Paths named by any .in(...): the parts the repo is split into, besides the root. */
  get parts(): string[] {
    const paths = this.project.claims.flatMap((e) => (e.kind === "claim" ? [] : e.paths.filter((p) => p !== "*")))
    return [...new Set(paths.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")))]
  }

  /** The part a file belongs to: the longest path containing it, else the root. */
  partOf(path: string): string {
    return this.parts.filter((p) => inPath(path, p)).sort((a, b) => b.length - a.length)[0] ?? "."
  }

  /** What the change owes: each owed entry in every touched part it covers, plus a step's claims. */
  owed(target?: Target): { owed: Owed[]; idle: Report["idle"] } {
    const touched = new Map<string, string[]>()
    for (const c of this.changes) touched.set(this.partOf(c.path), [...(touched.get(this.partOf(c.path)) ?? []), c.path])
    const owed: Owed[] = []
    const idle: { title: string; reason: string }[] = []
    const add = (claim: AnyClaim, paths: readonly string[], extra?: readonly string[]) => {
      const parts = [...touched.keys()].filter((part) => paths.includes("*") || paths.some((p) => inPath(part, p)))
      const chosen = parts.length ? parts : (extra ?? [])
      if (!chosen.length) idle.push({ title: claim.title, reason: paths.includes("*") ? "nothing changed" : `nothing changed in ${paths.join(", ")}` })
      for (const part of chosen) {
        if (owed.some((o) => o.claim === claim && o.part === part)) continue
        owed.push({ claim, part, reason: touched.has(part) ? `changed: ${list(touched.get(part)!)}` : `step "${target!.step.title}"` })
      }
    }
    for (const e of this.project.claims) {
      if (e.kind === "claim") add(e, ["*"])
      else if (e.kind === "owed") add(e.claim, e.paths)
    }
    if (target) for (const p of [...target.workflow.claims, ...target.step.claims]) add(p, ["*"], this.implementedIn(p))
    return { owed, idle }
  }

  /** Where a step's claim can run before anything changed: the parts its abstract claims are provided in. */
  private implementedIn(claim: AnyClaim): string[] {
    const abstract = (p: AnyClaim): AnyClaim[] => (p.type === "abstract" ? [p] : p.deps.flatMap(abstract))
    const paths = this.project.claims.flatMap((e) => (e.kind === "via" && abstract(claim).includes(e.claim) ? e.paths : []))
    return paths.includes("*") || !paths.length ? ["."] : [...new Set(paths)]
  }

  private runner(target?: Target): Runner {
    return new Runner({
      git: this.git,
      project: this.project,
      revs: this.revs,
      changes: this.changes.map((c) => ({ ...c, part: this.partOf(c.path) })),
      cache: this.options.cache,
      step: target?.step.title,
      workflow: target?.workflow.title,
    })
  }

  /** What the change owes, without running anything: each owed claim down to the abstract claims it reaches. */
  async plan(target?: Target): Promise<Report> {
    const runner = this.runner(target)
    const { owed, idle } = this.owed(target)
    const tree = (claim: AnyClaim, part: string): Node => {
      const missing = claim.type === "abstract" && !runner.resolve(claim, part)
      return {
        title: claim.title,
        type: claim.type,
        part,
        status: missing ? "missing" : "owed",
        findings: missing ? [`${claim.title} is not provided in ${where(part)}`] : [],
        children: claim.deps.map((d) => tree(d, part)),
      }
    }
    const claims = owed.map((o) => ({ ...tree(o.claim, o.part), reason: o.reason }))
    const ok = !claims.some(function bad(n: Node): boolean {
      return n.status === "missing" || n.children.some(bad)
    })
    return { base: this.revs.base, head: this.revs.head, ok, planned: true, claims, idle, runs: [] }
  }

  /** Run every owed claim. Failing calls are bisected when base..head holds more than one commit. */
  async run(target?: Target): Promise<Report> {
    const runner = this.runner(target)
    const { owed, idle } = this.owed(target)
    const claims = await Promise.all(owed.map(async (o) => ({ ...(await runner.prove(o.claim, o.part)), reason: o.reason })))
    if (this.options.bisect !== false && (await this.revs.commits()).length > 1) {
      const failing = [...runner.calls.keys()].filter((n) => n.status === "failed" && !n.fail && n.at === undefined)
      for (const node of failing) await runner.bisect(node)
    }
    return { base: this.revs.base, head: this.revs.head, ok: claims.every((p) => p.status === "passed"), planned: false, claims, idle, runs: runner.records }
  }
}
