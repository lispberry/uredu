// Small helpers for derived claims: fail with findings, compare values, compare timings.
import { git } from "./facts.ts"
import { ClaimFailure, type Bound } from "./claim.ts"
import type { Rev } from "./context.ts"
import { compare } from "./engine/stats.ts"

const describe = (x: unknown): string =>
  typeof x === "string" ? x : x instanceof Error ? x.message : x && typeof x === "object" && "message" in x ? String(x.message) : JSON.stringify(x)

/** Fail the running claim. Arrays become one finding per element. */
export function fail(...what: unknown[]): never {
  throw new ClaimFailure(what.flatMap((w) => (Array.isArray(w) ? w.map(describe) : [describe(w)])))
}

/**
 * Like Promise.all over `items`, but every item runs to the end and every failure is reported, not just the
 * first: `await all(await messages(), async (m) => { … })`.
 */
export async function all<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const settled = await Promise.allSettled(items.map(fn))
  const errors = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as Error] : []))
  if (!errors.length) return settled.map((s) => (s as PromiseFulfilledResult<R>).value)
  // a failed dependency already says why in its own report node
  const findings = errors.flatMap((e) => (e instanceof ClaimFailure ? e.findings : e.name === "DependencyFailed" ? [] : [e.message]))
  throw findings.length ? new ClaimFailure(findings) : errors[0]
}

/** Fail unless `now` deep-equals `before`. */
export function same(now: unknown, before: unknown, what = "output"): void {
  if (Bun.deepEquals(now, before)) return
  if (typeof now === "string" && typeof before === "string") {
    const [a, b] = [now.split("\n"), before.split("\n")]
    const line = a.findIndex((l, i) => l !== b[i])
    const at = line === -1 ? b.length : line
    fail(`${what} differs at line ${at + 1}: ${JSON.stringify(b[at] ?? "")} → ${JSON.stringify(a[at] ?? "")}`)
  }
  fail(`${what} differs`)
}

export interface FasterOptions {
  /** Confidence needed to call head slower (default 0.95). */
  readonly confidence?: number
  /** Interleaved runs per revision (default 5). */
  readonly rounds?: number
}

type Timed<I> = { at(rev: Rev, options?: { fresh?: boolean }): Bound<I, number | readonly number[]> }

/** Fail when head is confidently slower than `than`. Runs are interleaved and never cached. */
export async function faster<I>(claim: Timed<I>, input: I, than: Rev, options: FasterOptions = {}): Promise<void> {
  const mean = (x: number | readonly number[]) => (typeof x === "number" ? x : x.reduce((a, b) => a + b, 0) / x.length)
  const base: number[] = []
  const head: number[] = []
  const run = (rev: Rev) => (claim.at(rev, { fresh: true }) as (input: I) => Promise<number | readonly number[]>)(input)
  for (let i = 0; i < (options.rounds ?? 5); i++) {
    base.push(mean(await run(than)))
    head.push(mean(await run(git.head)))
  }
  const c = compare(base, head)
  if (1 - c.confidence >= (options.confidence ?? 0.95))
    fail(`${((c.headMean / c.baseMean - 1) * 100).toFixed(1)}% slower than ${than.ref} (confidence ${(1 - c.confidence).toFixed(3)})`)
}
