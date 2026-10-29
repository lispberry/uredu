// Rules read like test suites, Playwright-style: a rule declares the proofs it uses, and its body gets an
// `expect` limited to them.
//
//   export const regressionTest = rule("Bug fixes carry a regression test", {
//     when: task.is("fix"),
//     uses: { newTests },
//   }, ({ expect }) => {
//     expect(newTests).at(git.base).toFail()
//     expect(newTests).toPass()
//   })
//
//   export const shipSafely = rule("Ship safely", { include: [buildsAndPasses, honestTests, regressionTest] })
//
// A rule's type carries every (area, proof) pair it requires, taken from `uses` and `include`, so a project
// that cannot prove one of them fails to compile.
//
// Bodies may be async. Expectations run in parallel unless awaited or the rule is `serial`; included rules
// and `each` items are evaluated concurrently. Each evaluation gets its own scope, so nothing is shared.
import type { AnyCondition, Collection, Condition } from "./facts.ts"
import type { AnyProof } from "./proof.ts"
import { parseDuration, scopedExpect, start, type Duration, type Expect, type ExpectationSpec, type Runner, type Scope, type Slot, type Verdict } from "./expect.ts"

/** Area used when a rule's condition names no area (e.g. `task.is("fix")`): any provider of the proof will do. */
export type Anywhere = "*"

export interface Req<A extends string = string, P extends string = string, T extends string = string> {
  readonly area: A
  readonly proof: P
  readonly by: T
}

export type Uses = { readonly [name: string]: AnyProof }

type UsedNames<U extends Uses> = U[keyof U]["name"]

export type RuleContext<U extends Uses> = U & {
  /** Assert on a declared proof. Un-awaited expectations run in parallel; awaiting yields the Verdict. */
  readonly expect: Expect<UsedNames<U>>
  /** Evaluate a fact while the rule runs, e.g. `if (await holds(github.pr.labeled("perf")))`. */
  readonly holds: (condition: AnyCondition) => Promise<boolean>
  /** Aborted when the step is cancelled or the rule times out. */
  readonly signal: AbortSignal
}

export type Body<U extends Uses, I> = (ctx: RuleContext<U>, item: I) => void | Promise<void>

export interface RuleData {
  readonly kind: "rule"
  readonly title: string
  readonly when: AnyCondition | undefined
  readonly each: Collection<unknown, string> | undefined
  readonly uses: Uses
  readonly include: readonly AnyRule[]
  readonly body: Body<Uses, unknown> | undefined
  /** Run this rule's expectations one at a time, in order. */
  readonly serial: boolean
  readonly timeoutMs: number | undefined
}

export interface Rule<R extends Req = Req> extends RuleData {
  /** phantom: what this rule requires */
  readonly __reqs?: R
}

export type AnyRule = Rule<Req>

type Distribute<A extends string, P extends string, T extends string> = A extends string
  ? P extends string
    ? Req<A, P, T>
    : never
  : never

type OrAnywhere<A extends string> = [A] extends [never] ? Anywhere : A

/** A rule's condition moves its included rules' area-less requirements into its own areas. */
type Relocate<R, A extends string> = [A] extends [never]
  ? R
  : R extends Req<infer RA, infer P, infer T>
    ? RA extends Anywhere
      ? Distribute<A, P, T>
      : R
    : never

type IncludedReqs<Rs extends readonly AnyRule[]> = { [I in keyof Rs]: Rs[I] extends Rule<infer R> ? R : never }[number]

type ReqsOf<U extends Uses, Rs extends readonly AnyRule[], A extends string, T extends string> =
  | Distribute<OrAnywhere<A>, UsedNames<U>, T>
  | Relocate<IncludedReqs<Rs>, A>

export interface RuleOptions<U extends Uses, Rs extends readonly AnyRule[], A extends string, I> {
  /** Fires when the condition holds for the step's change. */
  readonly when?: Condition<A>
  /** Runs the body once per item, concurrently. */
  readonly each?: Collection<I, A>
  /** The proofs the body may expect. */
  readonly uses?: U
  /** Nested rules, evaluated concurrently when this rule fires. */
  readonly include?: Rs
  readonly serial?: boolean
  readonly timeout?: Duration
}

export function rule<
  const T extends string,
  const U extends Uses = {},
  const Rs extends readonly AnyRule[] = [],
  A extends string = never,
  I = void,
>(title: T, opts: RuleOptions<U, Rs, A, I>, body?: Body<U, I>): Rule<ReqsOf<U, Rs, A, T>> {
  if (opts.each && opts.include?.length) throw new Error(`rule "${title}": each-rules cannot include other rules`)
  if (body && !opts.uses) throw new Error(`rule "${title}": a body needs \`uses\` to declare its proofs`)
  for (const key of ["expect", "holds", "signal"]) if (opts.uses && key in opts.uses) throw new Error(`rule "${title}": \`${key}\` is reserved in uses`)
  return {
    kind: "rule",
    title,
    when: opts.when,
    each: opts.each,
    uses: opts.uses ?? {},
    include: opts.include ?? [],
    body: body as Body<Uses, unknown> | undefined,
    serial: opts.serial ?? false,
    timeoutMs: opts.timeout === undefined ? undefined : parseDuration(opts.timeout),
  }
}

/** Walk the include tree. */
export function* walk(rule: AnyRule, path: readonly AnyRule[] = []): Generator<{ rule: AnyRule; path: readonly AnyRule[] }> {
  yield { rule, path }
  for (const child of rule.include) yield* walk(child, [...path, rule])
}

// ── evaluation ───────────────────────────────────────────────────────────────────

export interface Facts {
  holds(condition: AnyCondition): Promise<boolean>
  items(collection: Collection<unknown, string>): Promise<readonly unknown[]>
}

export interface Evaluation {
  readonly rule: AnyRule
  readonly fired: boolean
  /** Skipped by a workflow step; the reason is recorded as a waiver. */
  readonly waived?: string
  readonly item?: unknown
  readonly results: readonly { readonly spec: ExpectationSpec; readonly verdict: Verdict }[]
  readonly children: readonly Evaluation[]
}

export interface EvaluateOptions {
  readonly facts: Facts
  readonly runner: Runner
  readonly signal?: AbortSignal
  /** Rules a workflow step skips, with the reason. */
  readonly waive?: ReadonlyMap<AnyRule, string>
}

/** Evaluate a rule tree. Included rules, `each` items and expectations run concurrently unless `serial`. */
export async function evaluate(rule: AnyRule, opts: EvaluateOptions): Promise<Evaluation> {
  const waived = opts.waive?.get(rule)
  if (waived !== undefined) return { rule, fired: false, waived, results: [], children: [] }
  const signal = withTimeout(opts.signal ?? new AbortController().signal, rule.timeoutMs)
  if (rule.when && !(await opts.facts.holds(rule.when))) return { rule, fired: false, results: [], children: [] }

  if (rule.each) {
    const items = await opts.facts.items(rule.each)
    const children = await Promise.all(items.map((item) => runBody(rule, item, { ...opts, signal })))
    return { rule, fired: items.length > 0, results: [], children }
  }

  const [own, children] = await Promise.all([
    rule.body ? runBody(rule, undefined, { ...opts, signal }) : undefined,
    Promise.all(rule.include.map((child) => evaluate(child, { ...opts, signal }))),
  ])
  return { rule, fired: true, results: own?.results ?? [], children }
}

async function runBody(rule: AnyRule, item: unknown, opts: EvaluateOptions & { signal: AbortSignal }): Promise<Evaluation> {
  const scope: Scope = { slots: [], runner: opts.runner, signal: opts.signal, context: { rule, item } }
  const ctx = {
    ...rule.uses,
    expect: scopedExpect(scope),
    holds: (c: AnyCondition) => opts.facts.holds(c),
    signal: opts.signal,
  } as unknown as RuleContext<Uses>
  await rule.body!(ctx, item)

  const allowed = new Set(Object.values(rule.uses).map((p) => p.name))
  for (const slot of scope.slots)
    if (!allowed.has(slot.spec.proof.name)) throw new Error(`rule "${rule.title}": expects ${slot.spec.proof.name}, which is not in uses`)

  const verdicts = rule.serial ? await inOrder(scope, scope.slots) : await Promise.all(scope.slots.map((s) => start(scope, s)))
  return { rule, fired: true, item, results: scope.slots.map((s, i) => ({ spec: s.spec, verdict: verdicts[i]! })), children: [] }
}

async function inOrder(scope: Scope, slots: readonly Slot[]): Promise<Verdict[]> {
  const out: Verdict[] = []
  for (const slot of slots) out.push(await start(scope, slot))
  return out
}

function withTimeout(signal: AbortSignal, ms: number | undefined): AbortSignal {
  return ms === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(ms)])
}
