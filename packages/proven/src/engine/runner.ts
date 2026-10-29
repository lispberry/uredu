// The runner: turns an expectation into runs of the bound prover, in clean worktrees at the right
// revisions, and into one verdict. Results are cached by (proof, args, instrument, directory, revision).
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AnyCondition } from "../facts.ts"
import type { ExpectationSpec, Finding, RunContext, Runner, Verdict } from "../expect.ts"
import type { Instrument } from "../instrument.ts"
import { claimOf } from "../proof.ts"
import type { AnyRule } from "../rule.ts"
import type { RepoFacts } from "./facts.ts"
import type { Git } from "./git.ts"
import { describe, execute } from "./instruments.ts"
import { inDir, type Bound, type Layout } from "./layout.ts"
import type { Revisions } from "./revs.ts"
import { compare } from "./stats.ts"

export interface RunRecord {
  readonly id: string
  readonly proof: string
  readonly claim: string
  readonly dir: string
  readonly sha: string
  readonly command: string
  readonly verdict: Verdict
  readonly cached: boolean
}

export interface RunnerOptions {
  readonly git: Git
  readonly layout: Layout
  readonly revs: Revisions
  readonly facts: RepoFacts
  /** Interleaved rounds per revision for toBeFaster. */
  readonly rounds?: number
  readonly cache?: boolean
  readonly setup?: Instrument
  readonly env?: Readonly<Record<string, string>>
}

const okVerdict: Verdict = { ok: true, findings: [], artifacts: [] }
const failed = (message: string): Verdict => ({ ok: false, findings: [{ message, severity: "error" }], artifacts: [] })

/** Areas a rule's condition is about (never those under `not`). Empty means anywhere. */
export function ruleAreas(rule: AnyRule | undefined): string[] {
  if (!rule) return []
  const out = new Set<string>()
  const visit = (c: AnyCondition) => {
    if (c.op === "and" || c.op === "or") c.args.forEach((a) => visit(a as AnyCondition))
    if (c.op.startsWith("git.") && Array.isArray(c.args[2])) for (const a of c.args[2] as { name: string }[]) out.add(a.name)
  }
  if (rule.when) visit(rule.when)
  if (rule.each) {
    const area = (rule.each.op === "git.symbols" ? rule.each.args[2] : rule.each.args[0]) as { name: string }
    out.add(area.name)
  }
  return [...out]
}

/** Which directories an expectation runs in: providers of the proof in the rule's areas, narrowed to touched ones. */
export async function targets(spec: ExpectationSpec, context: RunContext, layout: Layout, facts: RepoFacts): Promise<Bound[]> {
  const areas = ruleAreas(context.rule)
  const bound = layout.bindings(spec.proof.name).filter((b) => !areas.length || b.provider.areas.some((a) => areas.includes(a.name)))
  const changes = await facts.diff({ kind: "rev", ref: "base" }, { kind: "rev", ref: "head" })
  const touched = bound.filter((b) =>
    changes.some((ch) => inDir(ch.path, b.dir) && (!areas.length || areas.some((a) => layout.inArea(a, ch.path)))),
  )
  return touched.length ? touched : bound
}

export class ProofRunner implements Runner {
  readonly records: RunRecord[] = []
  private seq = 0

  constructor(readonly opts: RunnerOptions) {}

  async run(spec: ExpectationSpec, signal: AbortSignal, context: RunContext): Promise<Verdict> {
    const sig = spec.timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(spec.timeoutMs)])
    const where = await targets(spec, context, this.opts.layout, this.opts.facts)
    if (!where.length) return failed(`no provider binds ${spec.proof.name}${context.rule ? ` for "${context.rule.title}"` : ""}`)
    const verdicts = await Promise.all(where.map((t) => this.matcher(spec, t, sig)))
    let verdict = combine(where, verdicts)
    if (!verdict.ok)
      for (const f of spec.fallbacks) {
        const extra =
          f.op === "git.bisect"
            ? await this.bisect(spec, where[0]!, sig)
            : { message: `ask a human: ${f.args[0] as string}`, severity: "note" as const }
        verdict = { ...verdict, findings: [...verdict.findings, extra] }
      }
    return verdict
  }

  private async matcher(spec: ExpectationSpec, target: Bound, signal: AbortSignal): Promise<Verdict> {
    const at = spec.at ? await this.opts.revs.resolve(spec.at) : this.opts.revs.head
    const m = spec.matcher
    switch (m.kind) {
      case "toPass":
        return this.runAt(spec, target, at, signal)
      case "toFail": {
        const v = await this.runAt(spec, target, at, signal)
        return v.ok
          ? { ...v, ok: false, findings: [{ message: `${claimOf(spec.proof, spec.args)}: expected to fail at ${at.slice(0, 7)}, but it passed`, severity: "error" }] }
          : { ...v, ok: true, findings: [] }
      }
      case "toMatch": {
        const other = await this.opts.revs.resolve(m.against)
        const [h, b] = await Promise.all([this.runAt(spec, target, at, signal), this.runAt(spec, target, other, signal)])
        if (!h.ok || !b.ok) return { ...h, ok: false, findings: [...h.findings, ...b.findings] }
        if (h.value === undefined) return failed(`${spec.proof.name} has no value to compare; give its prover .value(...)`)
        const same = Bun.deepEquals(h.value, b.value)
        return {
          ...h,
          ok: same,
          findings: same ? [] : [{ message: `${claimOf(spec.proof, spec.args)} differs from ${other.slice(0, 7)}`, severity: "error" }],
        }
      }
      case "toBeFaster": {
        const than = await this.opts.revs.resolve(m.than)
        const base: number[] = []
        const head: number[] = []
        for (let i = 0; i < (this.opts.rounds ?? 5); i++) {
          for (const [sha, into] of [
            [than, base],
            [at, head],
          ] as const) {
            const v = await this.runAt(spec, target, sha, signal, false)
            if (!v.ok) return v
            if (!v.samples?.length) return failed(`${spec.proof.name} produced no samples; give its prover .samples(...)`)
            into.push(v.samples.reduce((a, b) => a + b, 0) / v.samples.length)
          }
        }
        const c = compare(base, head)
        const ok = c.confidence >= m.confidence || (m.orEqual && 1 - c.confidence < m.confidence)
        const pct = ((c.headMean / c.baseMean - 1) * 100).toFixed(1)
        const message = `${spec.proof.name}: head ${pct}% vs ${than.slice(0, 7)} (confidence faster ${c.confidence.toFixed(3)})`
        return { ok, value: c, samples: head, findings: ok ? [] : [{ message, severity: "error" }], artifacts: [] }
      }
      case "toPassAt": {
        const shas = (await this.opts.revs.commits()).map((c) => c.sha)
        if (!shas.length) shas.push(this.opts.revs.head)
        const verdicts = await Promise.all(shas.map((sha) => this.runAt(spec, target, sha, signal)))
        const findings = verdicts.flatMap((v, i) => v.findings.map((f) => ({ ...f, message: `${shas[i]!.slice(0, 7)}: ${f.message}` })))
        return { ok: verdicts.every((v) => v.ok), findings, artifacts: verdicts.flatMap((v) => v.artifacts) }
      }
    }
  }

  /** Run the bound prover once at `sha` in the target's directory of a clean worktree. */
  async runAt(spec: ExpectationSpec, target: Bound, sha: string, signal: AbortSignal, useCache = true): Promise<Verdict> {
    const prover = target.binding.prover
    const instrument: Instrument = typeof prover === "function" ? prover(spec.args) : prover
    const overlay = await this.overlay(spec, target, sha)
    const key = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([spec.proof.name, spec.args ?? null, instrument.spec, target.dir, sha, overlay]))
      .digest("hex")
    const cacheFile = this.opts.git.store("cache", `${key}.json`)
    const caching = useCache && this.opts.cache !== false && !instrument.spec.samples
    if (caching && (await Bun.file(cacheFile).exists())) {
      const verdict = (await Bun.file(cacheFile).json()) as Verdict
      this.record(spec, target, sha, instrument, verdict, true)
      return verdict
    }

    const tree = await this.checkout(sha, overlay)
    const id = `${Date.now().toString(36)}-${(this.seq++).toString(36)}-${spec.proof.name}`
    const runDir = this.opts.git.store("runs", id)
    const verdict =
      instrument.spec.source.kind === "builtin"
        ? await this.builtin(instrument, spec, target, sha, signal)
        : await execute(instrument, { cwd: join(tree, target.dir), runDir, signal, env: this.opts.env })
    if (caching) await Bun.write(cacheFile, JSON.stringify(verdict))
    await mkdir(runDir, { recursive: true })
    await Bun.write(join(runDir, "run.json"), JSON.stringify(this.record(spec, target, sha, instrument, verdict, false, id), null, 2))
    return verdict
  }

  private record(spec: ExpectationSpec, target: Bound, sha: string, instrument: Instrument, verdict: Verdict, cached: boolean, id = "cached"): RunRecord {
    const rec: RunRecord = {
      id,
      proof: spec.proof.name,
      claim: claimOf(spec.proof, spec.args),
      dir: target.dir,
      sha,
      command: describe(instrument),
      verdict,
      cached,
    }
    this.records.push(rec)
    return rec
  }

  /** For `newTests` on another revision: the test files the change added, to copy onto that revision. */
  private async overlay(spec: ExpectationSpec, target: Bound, sha: string): Promise<string[]> {
    if (spec.proof.name !== "newTests" || sha === this.opts.revs.head) return []
    return (await this.opts.facts.changedIn("tests"))
      .filter((ch) => ch.status === "added" && inDir(ch.path, target.dir))
      .map((ch) => ch.path)
  }

  private readonly prepared = new Map<string, Promise<string>>()

  /** A worktree at `sha` (plus overlay files), prepared once with the project's setup. */
  private checkout(sha: string, overlay: readonly string[]): Promise<string> {
    const name = overlay.length
      ? `${sha}+${new Bun.CryptoHasher("sha1").update(overlay.join("\n") + this.opts.revs.head).digest("hex").slice(0, 12)}`
      : sha
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
    const done = join(tree, ".git-proven-setup")
    if (this.opts.setup && !(await Bun.file(done).exists())) {
      const v = await execute(this.opts.setup, { cwd: tree, runDir: this.opts.git.store("runs", `setup-${name}`), signal: AbortSignal.timeout(600_000), env: this.opts.env })
      if (!v.ok) throw new Error(`setup failed in ${tree}: ${v.findings[0]!.message}`)
      await Bun.write(done, "")
    }
    return tree
  }

  /** Proofs the runner implements itself. */
  private async builtin(instrument: Instrument, spec: ExpectationSpec, target: Bound, sha: string, signal: AbortSignal): Promise<Verdict> {
    const source = instrument.spec.source as { name: string; options: Record<string, unknown> }
    if (source.name !== "testInventory") return failed(`builtin "${source.name}" is not implemented`)
    if (sha === this.opts.revs.base) return okVerdict
    const [before, after] = await Promise.all([
      this.inventory(source.options, spec, target, this.opts.revs.base, signal),
      this.inventory(source.options, spec, target, sha, signal),
    ])
    if (typeof before === "string" || typeof after === "string") return failed(typeof before === "string" ? before : (after as string))
    const findings: Finding[] = []
    if (after.tests < before.tests) findings.push({ message: `tests went from ${before.tests} to ${after.tests}`, severity: "error" })
    if (after.skipped > before.skipped) findings.push({ message: `skipped tests went from ${before.skipped} to ${after.skipped}`, severity: "error" })
    return { ok: !findings.length, value: after, findings, artifacts: [] }
  }

  /** Count tests (and skipped tests) at a revision: from a list command, or by scanning test files. */
  private async inventory(options: Record<string, unknown>, spec: ExpectationSpec, target: Bound, sha: string, signal: AbortSignal) {
    if (options.list) {
      const listing = await execute(options.list as Instrument, {
        cwd: join(await this.checkout(sha, []), target.dir),
        runDir: this.opts.git.store("runs", `inventory-${sha.slice(0, 12)}-${spec.proof.name}`),
        signal,
        env: this.opts.env,
      })
      if (!listing.ok) return `listing tests failed at ${sha.slice(0, 7)}: ${listing.findings[0]!.message}`
      const text = await Bun.file(this.opts.git.store("runs", `inventory-${sha.slice(0, 12)}-${spec.proof.name}`, "log")).text()
      return { tests: text.split("\n").filter((l) => /: test$/.test(l)).length, skipped: 0 }
    }
    const files = (await this.opts.git.git("ls-tree", "-r", "--name-only", sha)).split("\n").filter((f) => f && inDir(f, target.dir) && this.opts.layout.inArea("tests", f))
    let tests = 0
    let skipped = 0
    for (const f of files) {
      const src = await this.opts.git.show(sha, f)
      tests += [...src.matchAll(/\b(?:test|it)(?:\.only)?\s*\(/g)].length
      skipped += [...src.matchAll(/\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(/g)].length
    }
    return { tests: tests + skipped, skipped }
  }

  /** First revision in base..head where the proof stops passing. */
  private async bisect(spec: ExpectationSpec, target: Bound, signal: AbortSignal): Promise<Finding> {
    const candidates = (await this.opts.revs.commits()).map((c) => ({ sha: c.sha, subject: c.subject }))
    if (!candidates.length) candidates.push({ sha: this.opts.revs.head, subject: "the change" })
    let lo = 0
    let hi = candidates.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((await this.runAt(spec, target, candidates[mid]!.sha, signal)).ok) lo = mid + 1
      else hi = mid
    }
    const bad = candidates[lo]!
    return { message: `bisect: first failing ${bad.sha.slice(0, 7)} "${bad.subject}"`, severity: "note" }
  }
}

function combine(where: readonly Bound[], verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 1) return verdicts[0]!
  return {
    ok: verdicts.every((v) => v.ok),
    value: Object.fromEntries(where.map((t, i) => [t.dir, verdicts[i]!.value])),
    findings: verdicts.flatMap((v, i) => v.findings.map((f) => ({ ...f, message: `[${where[i]!.dir}] ${f.message}` }))),
    artifacts: verdicts.flatMap((v) => v.artifacts),
  }
}
