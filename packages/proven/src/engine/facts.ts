// Evaluating facts (conditions and collections) against a real repository, with a human-readable reason
// for every answer so plans can say why a rule fired or didn't.
import type { AnyArea, Area } from "../area.ts"
import type { AnyCondition, Collection, Intent, Rev } from "../facts.ts"
import type { Facts } from "../rule.ts"
import type { Change, Git } from "./git.ts"
import { symbolsIn, type Layout } from "./layout.ts"
import type { Revisions } from "./revs.ts"

export interface TaskInfo {
  readonly intent: Intent
  readonly declares: readonly string[]
}

/** GitHub facts, fetched by the caller (e.g. via `gh`). Absent means every github fact is false. */
export interface GithubInfo {
  readonly prOpened: boolean
  readonly prLabels: readonly string[]
  readonly issueLinked: boolean
  readonly issueLabels: readonly string[]
}

/** What a workflow step says it will touch; used instead of the diff when planning ahead. */
export interface Forecast {
  readonly areas: readonly string[]
  readonly symbols: Readonly<Record<string, readonly string[]>>
}

export interface Explained {
  readonly value: boolean
  readonly reason: string
}

export interface RepoFactsOptions {
  readonly git: Git
  readonly layout: Layout
  readonly revs: Revisions
  readonly task: TaskInfo
  readonly github?: GithubInfo
  readonly forecast?: Forecast
}

const list = (paths: readonly string[]) => (paths.length > 3 ? `${paths.slice(0, 3).join(", ")}, +${paths.length - 3} more` : paths.join(", "))

export class RepoFacts implements Facts {
  private readonly diffs = new Map<string, Promise<Change[]>>()

  constructor(readonly opts: RepoFactsOptions) {}

  async holds(condition: AnyCondition): Promise<boolean> {
    return (await this.explain(condition)).value
  }

  async explain(c: AnyCondition): Promise<Explained> {
    const args = c.args
    switch (c.op) {
      case "and":
      case "or": {
        const [a, b] = await Promise.all([this.explain(args[0] as AnyCondition), this.explain(args[1] as AnyCondition)])
        const value = c.op === "and" ? a.value && b.value : a.value || b.value
        return { value, reason: `(${a.reason}) ${c.op} (${b.reason})` }
      }
      case "not": {
        const inner = await this.explain(args[0] as AnyCondition)
        return { value: !inner.value, reason: `not (${inner.reason})` }
      }
      case "git.changed":
      case "git.added":
      case "git.deleted":
        return this.changed(c.op, args[0] as Rev, args[1] as Rev, args[2] as readonly AnyArea[])
      case "git.commits.mention": {
        const word = (args[0] as string).toLowerCase()
        const hits = (await this.opts.revs.commits()).filter((m) => `${m.subject}\n${m.body}`.toLowerCase().includes(word))
        return { value: hits.length > 0, reason: `commits mention "${word}": ${hits.length}` }
      }
      case "task.is":
        return { value: this.opts.task.intent === args[0], reason: `task is ${this.opts.task.intent}` }
      case "task.declares": {
        const value = this.opts.task.declares.includes(args[0] as string)
        return { value, reason: `task ${value ? "declares" : "does not declare"} "${args[0]}"` }
      }
      default:
        return this.github(c.op, args[0] as string | undefined)
    }
  }

  async items(collection: Collection<unknown, string>): Promise<readonly unknown[]> {
    const args = collection.args
    if (collection.op === "git.symbols") return this.symbols(args[0] as Rev, args[1] as Rev, args[2] as AnyArea)
    if (collection.op === "git.log") return this.log(args[0] as AnyArea, args[1] as Rev)
    throw new Error(`unknown collection: ${collection.op}`)
  }

  /** Changed files between two revisions that belong to an area. */
  async changedIn(name: string, a: Rev = { kind: "rev", ref: "base" }, b: Rev = { kind: "rev", ref: "head" }): Promise<Change[]> {
    return (await this.diff(a, b)).filter((ch) => this.opts.layout.inArea(name, ch.path))
  }

  async diff(a: Rev, b: Rev): Promise<Change[]> {
    const [sa, sb] = await Promise.all([this.opts.revs.resolve(a), this.opts.revs.resolve(b)])
    const key = `${sa}..${sb}`
    let hit = this.diffs.get(key)
    if (!hit) {
      hit = this.opts.git.diff(sa, sb)
      this.diffs.set(key, hit)
    }
    return hit
  }

  private async changed(op: string, a: Rev, b: Rev, areas: readonly AnyArea[]): Promise<Explained> {
    const names = areas.map((x) => x.name)
    const label = `${op}(${names.join(", ")})`
    const forecast = names.filter((n) => this.opts.forecast?.areas.includes(n))
    if (forecast.length) return { value: true, reason: `${label}: forecast` }
    const want = op === "git.added" ? "added" : op === "git.deleted" ? "deleted" : undefined
    const hits = (await this.diff(a, b)).filter((ch) => (!want || ch.status === want) && names.some((n) => this.opts.layout.inArea(n, ch.path)))
    return { value: hits.length > 0, reason: hits.length ? `${label}: ${list(hits.map((h) => h.path))}` : `${label}: nothing` }
  }

  private github(op: string, label: string | undefined): Explained {
    const gh = this.opts.github
    if (!gh) return { value: false, reason: `${label ? `${op}("${label}")` : op}: github not available` }
    const value =
      op === "github.pr.opened"
        ? gh.prOpened
        : op === "github.pr.labeled"
          ? gh.prLabels.includes(label!)
          : op === "github.issue.linked"
            ? gh.issueLinked
            : op === "github.issue.labeled"
              ? gh.issueLabels.includes(label!)
              : unknown(op)
    return { value, reason: label ? `${op}("${label}"): ${value}` : `${op}: ${value}` }
  }

  private async symbols(a: Rev, b: Rev, area: Area<string>): Promise<string[]> {
    const forecast = this.opts.forecast?.symbols[area.name] ?? []
    const sha = await this.opts.revs.resolve(b)
    const found = new Set(forecast)
    for (const ch of await this.diff(a, b)) {
      if (ch.status === "deleted") continue
      const matchers = this.opts.layout.placementsFor(area.name, ch.path).flatMap((p) => (p.area.symbols ? [p.area.symbols] : []))
      if (!matchers.length) continue
      const source = await this.opts.git.show(sha, ch.path)
      for (const m of matchers) for (const s of symbolsIn(source, m)) found.add(s)
    }
    return [...found]
  }

  private async log(area: AnyArea, since: Rev): Promise<Rev[]> {
    const from = await this.opts.revs.resolve(since)
    const commits = await this.opts.git.commits(from, this.opts.revs.head)
    const out: Rev[] = []
    for (const commit of commits) {
      const files = (await this.opts.git.git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit.sha)).split("\n").filter(Boolean)
      if (files.some((f) => this.opts.layout.inArea(area.name, f))) out.push({ kind: "rev", ref: `ref:${commit.sha}` })
    }
    return out
  }
}

function unknown(op: string): never {
  throw new Error(`unknown fact: ${op}`)
}
