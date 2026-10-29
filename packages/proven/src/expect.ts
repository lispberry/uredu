// expect(proof).toPass() — the assertion inside a rule. The "value" under test is a proof run by the runner,
// optionally at another revision or compared across revisions.
//
// Expectations are thenables. Left un-awaited they run in parallel with the rest of the rule; awaited, they
// resolve to a Verdict, so a rule can order work or decide what to expect next.
import type { AnyProof, Proof } from "./proof.ts"
import type { Fallback, Rev, Revs } from "./facts.ts"

export type Matcher =
  | { readonly kind: "toPass" }
  | { readonly kind: "toFail" }
  | { readonly kind: "toMatch"; readonly against: Rev }
  | { readonly kind: "toBeFaster"; readonly than: Rev; readonly confidence: number; readonly orEqual: boolean }
  | { readonly kind: "toPassAt"; readonly revs: Revs }

export interface Retry {
  readonly max: number
  /** Instruction for the agent's fix step; the finding is attached. */
  readonly fix: string
}

/** "90s", "30m", "2h", or milliseconds. */
export type Duration = `${number}${"ms" | "s" | "m" | "h"}` | number

export interface Finding {
  readonly message: string
  readonly location?: { readonly file: string; readonly line?: number }
  readonly reproducer?: string
  readonly severity: "error" | "warning" | "note"
}

export interface Verdict {
  readonly ok: boolean
  /** True when produced by planning rather than by running the proof. */
  readonly planned?: boolean
  readonly value?: unknown
  readonly samples?: readonly number[]
  readonly findings: readonly Finding[]
  readonly artifacts: readonly string[]
}

export interface ExpectationSpec {
  readonly proof: AnyProof
  readonly args: unknown
  readonly at: Rev | undefined
  readonly matcher: Matcher
  readonly retries: Retry | undefined
  readonly fallbacks: readonly Fallback[]
  readonly timeoutMs: number | undefined
}

export interface Expectation<P extends string = string> extends PromiseLike<Verdict> {
  readonly kind: "expectation"
  readonly spec: ExpectationSpec
  /** phantom: the proof this expectation needs a provider for */
  readonly __proof?: P
  retry(retry: Retry): Expectation<P>
  otherwise(fallback: Fallback): Expectation<P>
  timeout(duration: Duration): Expectation<P>
}

export type AnyExpectation = Expectation<string>

export interface Subject<P extends string> {
  /** Run the proof on another revision. For `newTests`, the new tests are overlaid onto that revision. */
  at(rev: Rev): Subject<P>
  toPass(): Expectation<P>
  toFail(): Expectation<P>
  /** The proof's value equals its value at `rev`. */
  toMatch(rev: Rev): Expectation<P>
  /** Interleaved samples at head beat `rev` with the given confidence. */
  toBeFaster(rev: Rev, opts?: { confidence?: number; orEqual?: boolean }): Expectation<P>
  /** Passes at every revision, e.g. every commit in base..head. */
  toPassAt(revs: Revs): Expectation<P>
}

type ArgsParam<A> = [A] extends [void] ? [] : [args: A]

/** An expect function limited to the proofs a rule declared in `uses`. */
export type Expect<Allowed extends string> = <N extends Allowed, A>(proof: Proof<N, A>, ...args: ArgsParam<A>) => Subject<N>

/** Where an expectation came from: the rule (and `each` item) that registered it, if any. */
export interface RunContext {
  readonly rule: import("./rule.ts").AnyRule | undefined
  readonly item: unknown
}

/** Runs expectations. The engine runs proofs; the planner answers without running anything. */
export interface Runner {
  run(spec: ExpectationSpec, signal: AbortSignal, context: RunContext): Promise<Verdict>
}

/** One registered expectation. Modifiers replace the spec until the expectation starts running. */
export interface Slot {
  spec: ExpectationSpec
  started: Promise<Verdict> | undefined
}

export interface Scope {
  readonly slots: Slot[]
  readonly runner: Runner | undefined
  readonly signal: AbortSignal
  readonly context: RunContext
}

export function parseDuration(d: Duration): number {
  if (typeof d === "number") return d
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(d)
  if (!m) throw new Error(`invalid duration: ${d}`)
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"]
}

export function start(scope: Scope, slot: Slot): Promise<Verdict> {
  if (!scope.runner) throw new Error(`expect(${slot.spec.proof.name}) cannot be awaited here: nothing runs proofs in this scope`)
  return (slot.started ??= scope.runner.run(slot.spec, scope.signal, scope.context))
}

/** Create an `expect` bound to one scope (one rule evaluation, or one workflow step). */
export function scopedExpect<Allowed extends string>(scope: Scope): Expect<Allowed> {
  return ((proof: AnyProof, args?: unknown) => subject(scope, proof, args, undefined)) as Expect<Allowed>
}

function subject<P extends string>(scope: Scope, proof: AnyProof, args: unknown, at: Rev | undefined): Subject<P> {
  const make = (matcher: Matcher) => {
    const slot: Slot = { spec: { proof, args, at, matcher, retries: undefined, fallbacks: [], timeoutMs: undefined }, started: undefined }
    scope.slots.push(slot)
    return expectation<P>(scope, slot)
  }
  return {
    at: (rev) => subject(scope, proof, args, rev),
    toPass: () => make({ kind: "toPass" }),
    toFail: () => make({ kind: "toFail" }),
    toMatch: (against) => make({ kind: "toMatch", against }),
    toBeFaster: (than, opts = {}) =>
      make({ kind: "toBeFaster", than, confidence: opts.confidence ?? 0.95, orEqual: opts.orEqual ?? false }),
    toPassAt: (revs) => make({ kind: "toPassAt", revs }),
  }
}

function expectation<P extends string>(scope: Scope, slot: Slot): Expectation<P> {
  const modify = (change: Partial<ExpectationSpec>) => {
    if (slot.started) throw new Error(`expect(${slot.spec.proof.name}): modifiers must come before await`)
    slot.spec = { ...slot.spec, ...change }
    return self
  }
  const self: Expectation<P> = {
    kind: "expectation",
    get spec() {
      return slot.spec
    },
    retry: (retries) => modify({ retries }),
    otherwise: (fallback) => modify({ fallbacks: [...slot.spec.fallbacks, fallback] }),
    timeout: (d) => modify({ timeoutMs: parseDuration(d) }),
    then: (onfulfilled, onrejected) => start(scope, slot).then(onfulfilled, onrejected),
  }
  return self
}
