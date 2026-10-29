// Facts are what rules read: git history, the task, GitHub. They are values, evaluated by the runner,
// so a plan can show which rules fired and which did not, and why.
import type { AnyArea, Area } from "./area.ts"

export interface Condition<A extends string = never> {
  readonly kind: "condition"
  readonly op: string
  readonly args: readonly unknown[]
  /** phantom: areas this condition is about; rules owe their proofs in these areas */
  readonly __areas?: A
  and<B extends string>(other: Condition<B>): Condition<A | B>
  or<B extends string>(other: Condition<B>): Condition<A | B>
}

export type AnyCondition = Condition<string>

function condition<A extends string = never>(op: string, ...args: unknown[]): Condition<A> {
  return {
    kind: "condition",
    op,
    args,
    and: (other) => condition("and", self(op, args), other),
    or: (other) => condition("or", self(op, args), other),
  }
}
const self = (op: string, args: readonly unknown[]) => ({ kind: "condition", op, args })

/** Negation drops areas: "not touching X" says nothing about where proofs run. */
export function not(c: AnyCondition): Condition<never> {
  return condition("not", c)
}

export interface Collection<T, A extends string = never> {
  readonly kind: "collection"
  readonly op: string
  readonly args: readonly unknown[]
  readonly __item?: T
  readonly __areas?: A
}

function collection<T, A extends string = never>(op: string, ...args: unknown[]): Collection<T, A> {
  return { kind: "collection", op, args }
}

// ── git ─────────────────────────────────────────────────────────────────────────

export interface Rev {
  readonly kind: "rev"
  readonly ref: string
}
const rev = (ref: string): Rev => ({ kind: "rev", ref })

export interface Revs {
  readonly kind: "revs"
  readonly range: readonly [Rev, Rev]
  mention(word: string): Condition<never>
}

type Names<As extends readonly AnyArea[]> = As[number]["name"]

export interface Diff {
  changed<const As extends readonly AnyArea[]>(...areas: As): Condition<Names<As>>
  added<const As extends readonly AnyArea[]>(...areas: As): Condition<Names<As>>
  deleted<const As extends readonly AnyArea[]>(...areas: As): Condition<Names<As>>
  /** Symbols (structs, functions, messages) of an area that changed between the two revisions. */
  symbols<N extends string>(area: Area<N>): Collection<string, N>
}

function diff(a: Rev, b: Rev): Diff {
  return {
    changed: (...areas) => condition("git.changed", a, b, areas),
    added: (...areas) => condition("git.added", a, b, areas),
    deleted: (...areas) => condition("git.deleted", a, b, areas),
    symbols: (area) => collection("git.symbols", a, b, area),
  }
}

export interface Fallback {
  readonly kind: "fallback"
  readonly op: string
  readonly args: readonly unknown[]
}

const base = rev("base")
const head = rev("head")

export const git = {
  /** Where the current step started. */
  base,
  /** The current tree. */
  head,
  mergeBase: (branch: string) => rev(`merge-base:${branch}`),
  ref: (ref: string) => rev(`ref:${ref}`),
  /** Snapshot taken when a workflow step closed. */
  step: (step: string | { readonly id: string }) => rev(`step:${typeof step === "string" ? step : step.id}`),
  commits: {
    kind: "revs",
    range: [base, head],
    mention: (word: string) => condition("git.commits.mention", word),
  } satisfies Revs as Revs,
  changed: <const As extends readonly AnyArea[]>(...areas: As): Condition<Names<As>> => condition("git.changed", base, head, areas),
  diff,
  log: {
    touching: (area: AnyArea) => ({ since: (from: Rev) => collection<Rev>("git.log", area, from) }),
  },
  /** On failure, find the first commit in base..head where the proof fails. */
  bisect: { kind: "fallback", op: "git.bisect", args: [] } satisfies Fallback as Fallback,
}

// ── task, github ────────────────────────────────────────────────────────────────

export type Intent = "change" | "design" | "fix" | "refactor" | "optimize" | "review"

export const task = {
  is: (intent: Intent) => condition("task.is", intent),
  declares: (what: string) => condition("task.declares", what),
}

export const github = {
  pr: {
    opened: condition("github.pr.opened"),
    labeled: (label: string) => condition("github.pr.labeled", label),
  },
  issue: {
    linked: condition("github.issue.linked"),
    labeled: (label: string) => condition("github.issue.labeled", label),
  },
}

export function askHuman(message: string): Fallback {
  return { kind: "fallback", op: "askHuman", args: [message] }
}
