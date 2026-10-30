// The runner evaluates claims. Derived claims run in-process; abstract ones run the project's .via in a
// clean worktree at the requested revision, inside the part's directory, cached by
// (claim, input, implementation, part, revision, overlay, output schema). Every call becomes a node in the
// report tree.
import { deserialize, serialize } from "bun:jsc"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { storage, type CallOptions, type Change, type Context, type Engine, type Node } from "../context.ts"

export type { Node }
import { ClaimFailure, type AnyClaim, type AnyVia } from "../claim.ts"
import { ready, type Project } from "../project.ts"
import type { Git } from "./git.ts"
import type { Revisions } from "./revs.ts"

export interface RunRecord {
  readonly id: string
  readonly claim: string
  readonly part: string
  readonly sha: string
  readonly ok: boolean
  readonly cached: boolean
}

export interface RunnerOptions {
  readonly git: Git
  readonly project: Project
  readonly revs: Revisions
  /** Changes in base..head, each with the part it belongs to. */
  readonly changes: readonly { readonly path: string; readonly part: string; readonly status: Change["status"] }[]
  readonly cache?: boolean
  readonly step?: string
  readonly workflow?: string
}

interface Outcome {
  readonly ok: boolean
  readonly output?: unknown
}

/** A dependency failed; its node already says why. */
class DependencyFailed extends Error {
  override name = "DependencyFailed"
}

interface AbstractCall {
  readonly claim: AnyClaim
  readonly input: unknown
  readonly part: string
  readonly sha: string
}

export const inPath = (path: string, dir: string) => dir === "." || path === dir || path.startsWith(`${dir}/`)

export class Runner implements Engine {
  readonly records: RunRecord[] = []
  /** Abstract calls by node, for bisecting failures. */
  readonly calls = new Map<Node, AbstractCall>()
  private readonly prepared = new Map<string, Promise<string>>()
  private seq = 0

  constructor(readonly opts: RunnerOptions) {}

  get step() {
    return this.opts.step
  }
  get workflow() {
    return this.opts.workflow
  }

  async changes(): Promise<readonly Change[]> {
    const part = storage.getStore()!.part
    return this.opts.changes
      .filter((c) => c.part === part)
      .map((c) => ({ path: part === "." ? c.path : c.path.slice(part.length + 1), status: c.status }))
  }

  commits() {
    return this.opts.revs.commits()
  }

  /** Evaluate an owed claim in a part, at head. */
  async prove(claim: AnyClaim, part: string): Promise<Node> {
    const root: Node = { title: claim.title, type: claim.type, part, status: "passed", findings: [], children: [] }
    const ctx: Context = { engine: this, within: undefined, part, sha: this.opts.revs.head, cwd: "", env: this.opts.project.env, log: undefined, node: root, pending: [] }
    await storage.run(ctx, () => this.evaluate(claim, {}, root, ctx, {}))
    return root
  }

  /** A call from inside a claim body. */
  async call(claim: AnyClaim, input: unknown, options: CallOptions): Promise<unknown> {
    const ctx = storage.getStore()!
    if (ctx.within && !ctx.within.deps.includes(claim))
      throw new Error(`"${ctx.within.title}" calls "${claim.title}" but doesn't list it in its deps`)
    const sha = options.at ? await this.opts.revs.resolve(options.at) : ctx.sha
    const node: Node = {
      title: claim.title,
      type: claim.type,
      part: ctx.part,
      status: "passed",
      findings: [],
      children: [],
      input,
      at: sha === this.opts.revs.head ? undefined : options.at ? options.at.ref : sha.slice(0, 7),
      fail: options.fail,
    }
    ctx.node.children.push(node)
    const run = this.evaluate(claim, input, node, { ...ctx, sha }, options)
    ctx.pending.push(run)
    const outcome = await run
    if (options.fail) {
      node.status = outcome.ok ? "failed" : "passed"
      if (!outcome.ok) node.findings.splice(0) // failing was the point
      else {
        node.findings.push("expected to fail, but it passed")
        throw new DependencyFailed()
      }
      return undefined
    }
    if (!outcome.ok) throw new DependencyFailed()
    return outcome.output
  }

  private async evaluate(claim: AnyClaim, input: unknown, node: Node, ctx: Context, options: CallOptions): Promise<Outcome> {
    const outcome =
      claim.type === "abstract"
        ? await this.abstract(claim, input, node, ctx, options)
        : claim.type === "group"
          ? await this.group(claim, node, ctx)
          : await this.derived(claim, node, ctx)
    node.status = outcome.ok ? "passed" : node.status === "missing" ? "missing" : "failed"
    return outcome
  }

  private async group(claim: AnyClaim, node: Node, ctx: Context): Promise<Outcome> {
    const results = await Promise.all(
      claim.deps.map((dep) => {
        const child: Node = { title: dep.title, type: dep.type, part: ctx.part, status: "passed", findings: [], children: [] }
        node.children.push(child)
        return this.evaluate(dep, {}, child, { ...ctx, within: undefined, node: child, pending: [] }, {})
      }),
    )
    return { ok: results.every((r) => r.ok) }
  }

  private async derived(claim: AnyClaim, node: Node, ctx: Context): Promise<Outcome> {
    const inner: Context = { ...ctx, within: claim, node, pending: [] }
    try {
      const output = await storage.run(inner, () => claim.body!())
      await Promise.allSettled(inner.pending)
      return { ok: node.children.every((c) => c.status === "passed"), output }
    } catch (e) {
      await Promise.allSettled(inner.pending)
      if (!(e instanceof DependencyFailed)) node.findings.push(...findingsOf(e))
      return { ok: false }
    }
  }

  private async abstract(claim: AnyClaim, input: unknown, node: Node, ctx: Context, options: CallOptions): Promise<Outcome> {
    const via = this.resolve(claim, ctx.part)
    if (!via) {
      node.status = "missing"
      node.findings.push(`${claim.title} is not provided in ${ctx.part === "." ? "the repo" : ctx.part}`)
      return { ok: false }
    }
    const parsed = claim.input ? claim.input.safeParse(input) : { success: true as const, data: input }
    if (!parsed.success) {
      node.findings.push(...issues(parsed.error))
      return { ok: false }
    }
    this.calls.set(node, { claim, input: parsed.data, part: ctx.part, sha: ctx.sha })
    const overlay = (options.overlay ?? []).map((f) => (ctx.part === "." ? f : join(ctx.part, f)))
    const result = await this.run(via, parsed.data, ctx, ctx.sha, overlay, !options.fresh)
    node.cached = result.cached
    node.findings.push(...result.findings)
    return result
  }

  /** Run an implementation once: from the cache, or in a worktree at `sha` (`tree`, when it's already there). */
  async run(via: AnyVia, input: unknown, ctx: Context, sha: string, overlay: readonly string[], caching: boolean, tree?: string) {
    const claim = via.claim
    const schema = claim.output ? JSON.stringify(z.toJSONSchema(claim.output, { unrepresentable: "any" })) : ""
    const key = new Bun.CryptoHasher("sha256").update(JSON.stringify([claim.title, input, String(via.impl), ctx.part, sha, overlay, schema])).digest("hex")
    const cacheFile = this.opts.git.store("cache", `${key}.bin`)
    caching &&= this.opts.cache !== false
    if (caching && (await Bun.file(cacheFile).exists())) {
      const hit = deserialize(await Bun.file(cacheFile).arrayBuffer()) as { ok: boolean; output: unknown; findings: string[] }
      if (!hit.ok || !claim.output || claim.output.safeParse(hit.output).success) {
        this.records.push({ id: "cached", claim: claim.title, part: ctx.part, sha, ok: hit.ok, cached: true })
        return { ...hit, cached: true }
      }
    }

    const dir = tree ?? (await this.checkout(sha, overlay).catch((e: Error) => e))
    if (dir instanceof Error) return { ok: false, output: undefined, findings: [dir.message], cached: false }
    const id = `${Date.now().toString(36)}-${(this.seq++).toString(36)}`
    const runDir = this.opts.git.store("runs", id)
    await mkdir(runDir, { recursive: true })
    const where: Context = { ...ctx, within: claim, sha, cwd: join(dir, ctx.part), log: join(runDir, "log"), pending: [] }
    let result: { ok: boolean; output: unknown; findings: string[] }
    try {
      const raw = await storage.run(where, async () => await via.impl(input as never))
      const out = claim.output ? claim.output.safeParse(raw) : { success: true as const, data: undefined }
      result = out.success ? { ok: true, output: out.data, findings: [] } : { ok: false, output: undefined, findings: issues(out.error) }
    } catch (e) {
      result = { ok: false, output: undefined, findings: findingsOf(e) }
    }
    if (caching) await Bun.write(cacheFile, serialize(result))
    const record: RunRecord = { id, claim: claim.title, part: ctx.part, sha, ok: result.ok, cached: false }
    this.records.push(record)
    await Bun.write(join(runDir, "run.json"), JSON.stringify({ ...record, input, findings: result.findings }, null, 2))
    return { ...result, cached: false }
  }

  /** The implementation of `claim` for a part: the most specific .via whose path covers it, the last one listed winning ties. */
  resolve(claim: AnyClaim, part: string): AnyVia | undefined {
    let best: AnyVia | undefined
    let depth = -1
    for (const e of this.opts.project.claims) {
      if (e.kind !== "via" || e.claim !== claim) continue
      for (const p of e.paths) {
        const d = p === "*" ? 0 : inPath(part, p) ? p.split("/").length : -1
        if (d >= depth && d >= 0) {
          best = e
          depth = d
        }
      }
    }
    return best
  }

  /** A worktree at `sha` (plus overlay files from head), made ready once. */
  private checkout(sha: string, overlay: readonly string[]): Promise<string> {
    const name = overlay.length ? `${sha}+${new Bun.CryptoHasher("sha1").update(overlay.join("\n") + this.opts.revs.head).digest("hex").slice(0, 12)}` : sha
    let hit = this.prepared.get(name)
    if (!hit) {
      hit = this.prepare(sha, name, overlay)
      this.prepared.set(name, hit)
    }
    return hit
  }

  private async prepare(sha: string, name: string, overlay: readonly string[]): Promise<string> {
    const tree = await this.opts.git.worktree(sha, name)
    for (const path of overlay) {
      await mkdir(dirname(join(tree, path)), { recursive: true })
      await Bun.write(join(tree, path), await this.opts.git.show(this.opts.revs.head, path))
    }
    const done = join(tree, ".git-uredu-ready")
    const via = this.resolve(ready, ".")
    if (via && !(await Bun.file(done).exists())) {
      const node: Node = { title: ready.title, type: "abstract", part: ".", status: "passed", findings: [], children: [] }
      const ctx: Context = { engine: this, within: ready, part: ".", sha, cwd: tree, env: this.opts.project.env, log: undefined, node, pending: [] }
      const r = await this.run(via, {}, ctx, sha, overlay, false, tree)
      if (!r.ok) throw new Error(`${ready.title} failed in ${tree}: ${r.findings.join("; ")}`)
      await Bun.write(done, "")
    }
    return tree
  }

  /** First commit in base..head where a failing abstract call starts failing. */
  async bisect(node: Node): Promise<void> {
    const call = this.calls.get(node)!
    const commits = await this.opts.revs.commits()
    let lo = 0
    let hi = commits.length - 1
    const ctx: Context = { engine: this, within: call.claim, part: call.part, sha: call.sha, cwd: "", env: this.opts.project.env, log: undefined, node, pending: [] }
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((await this.run(this.resolve(call.claim, call.part)!, call.input, ctx, commits[mid]!.sha, [], true)).ok) lo = mid + 1
      else hi = mid
    }
    node.findings.push(`bisect: first failing ${commits[lo]!.sha.slice(0, 7)} "${commits[lo]!.subject}"`)
  }
}

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.length ? i.path.join(".") : "value"}: ${i.message}`)

function findingsOf(e: unknown): string[] {
  if (e instanceof ClaimFailure) return [...e.findings]
  return [e instanceof Error ? e.message : String(e)]
}
