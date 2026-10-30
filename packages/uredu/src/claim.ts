// Claims are facts as async functions, typed with Zod. Three kinds:
//
//   abstract  claim("Frame time", { scene: z.string() }, { p99: z.number() })   the project provides it with .via
//   derived   claim("No regression", async () => { … }, [frameTime])            computed from its deps and git
//   group     claim("Game", [noRegression, replaysUnchanged])                  all of the listed claims
//
// Inside a derived body a dep is called like a function: `await frameTime({ scene: "x" })`.
import { z } from "zod"
import { current, type CallOptions, type Rev } from "./context.ts"

export type Shape = z.ZodRawShape
export type OutputSpec = z.ZodType | Shape
type Out<O> = O extends z.ZodType ? z.output<O> : O extends Shape ? z.output<z.ZodObject<O>> : void

/**
 * Which abstract claims a claim reaches, each with the path of derived claims that leads to it:
 * a union of [abstract name, path]. An abstract claim's own entry has an empty path.
 */
export type Need = readonly [string, string]

type Prefix<Ns, By extends string> = Ns extends readonly [infer A extends string, infer P extends string]
  ? readonly [A, P extends "" ? By : `${By} → ${P}`]
  : never
export type NeedsOf<P> = P extends Claim<string, infer _I, infer _O, infer N> ? N : never
type DepsNeeds<Ds extends readonly AnyClaim[], By extends string> = Prefix<NeedsOf<Ds[number]>, By>

/** Arguments of a call: optional when every input is optional. */
type Args<I> = {} extends I ? [input?: I] : [input: I]

export interface Claim<N extends string, I, O, Ns extends Need> {
  (...args: Args<I>): Promise<O>
  readonly kind: "claim"
  readonly title: N
  readonly type: "abstract" | "derived" | "group"
  readonly input: z.ZodObject | undefined
  readonly output: z.ZodType | undefined
  readonly deps: readonly AnyClaim[]
  readonly body: (() => Promise<O>) | undefined
  /** Run at another revision: `frameTime.at(git.base)({ scene })`. */
  at(rev: Rev, options?: Pick<CallOptions, "overlay" | "fresh">): Bound<I, O>
  /** Require the claim to fail. */
  fails(...args: Args<I>): Promise<void>
  /** Owe this claim only for changes under these paths. */
  in<const S extends string>(...paths: S[]): Owed<this, S>
  /** How this project proves an abstract claim. */
  via(impl: (input: I) => PromiseLike<O> | O): Via<N, "*">
  readonly __needs?: Ns
}

/** A claim pinned to a revision. */
export interface Bound<I, O> {
  (...args: Args<I>): Promise<O>
  fails(...args: Args<I>): Promise<void>
}

export type AnyClaim = Claim<string, any, any, Need>

/** A claim owed for changes under `paths`. */
export interface Owed<P extends AnyClaim, S extends string> {
  readonly kind: "owed"
  readonly claim: P
  readonly paths: readonly S[]
}

/** An implementation of an abstract claim, optionally scoped to paths ("*" means the whole repo). */
export interface Via<N extends string, S extends string> {
  readonly kind: "via"
  readonly claim: AnyClaim
  readonly impl: (input: never) => unknown
  readonly paths: readonly S[]
  readonly __name?: N
  in<const T extends string>(...paths: T[]): Via<N, T>
}
export type AnyVia = Via<string, string>

/** A list of `.via` lines that can be scoped as a whole: `...cargo.in("sim")`. */
export interface Kit<V extends AnyVia> extends ReadonlyArray<V> {
  in<const T extends string>(...paths: T[]): Via<V extends Via<infer N, string> ? N : never, T>[]
}

export function kit<const V extends readonly AnyVia[]>(...vias: V): Kit<V[number]> {
  return Object.assign([...vias], {
    in: (...paths: string[]) => vias.map((v) => v.in(...paths)),
  }) as unknown as Kit<V[number]>
}

export function claim<const N extends string>(title: N): Claim<N, {}, void, readonly [N, ""]>
export function claim<const N extends string, const S extends Shape, const O extends OutputSpec | undefined = undefined>(
  title: N,
  input: S,
  output?: O,
): Claim<N, z.input<z.ZodObject<S>>, Out<O>, readonly [N, ""]>
export function claim<const N extends string, O, const Ds extends readonly AnyClaim[]>(
  title: N,
  body: () => Promise<O>,
  deps: Ds,
): Claim<N, {}, O, DepsNeeds<Ds, N>>
export function claim<const N extends string, const Ds extends readonly AnyClaim[]>(title: N, deps: Ds): Claim<N, {}, void, DepsNeeds<Ds, N>>
export function claim(title: string, a?: unknown, b?: unknown): AnyClaim {
  if (typeof a === "function") return make(title, "derived", undefined, undefined, b as readonly AnyClaim[], a as () => Promise<unknown>)
  if (Array.isArray(a)) return make(title, "group", undefined, undefined, a as readonly AnyClaim[], undefined)
  const output = b === undefined ? undefined : b instanceof z.ZodType ? b : z.object(b as Shape)
  return make(title, "abstract", a === undefined ? undefined : z.object(a as Shape), output, [], undefined)
}

function make(
  title: string,
  type: AnyClaim["type"],
  input: z.ZodObject | undefined,
  output: z.ZodType | undefined,
  deps: readonly AnyClaim[],
  body: (() => Promise<unknown>) | undefined,
): AnyClaim {
  for (const d of deps) if (d?.kind !== "claim") throw new Error(`claim "${title}": deps must be claims`)
  const call = (options: CallOptions) =>
    Object.assign((input?: unknown) => current().engine.call(self, input ?? {}, options), {
      fails: async (input?: unknown) => void (await current().engine.call(self, input ?? {}, { ...options, fail: true })),
    })
  const self = Object.assign(call({}), {
    kind: "claim" as const,
    type,
    input,
    output,
    deps,
    body,
    at: (rev: Rev, options: Pick<CallOptions, "overlay" | "fresh"> = {}) => call({ ...options, at: rev }),
    in: (...paths: string[]) => ({ kind: "owed" as const, claim: self, paths }),
    via: (impl: (input: never) => unknown) => {
      if (type !== "abstract") throw new Error(`"${title}" is ${type}; only abstract claims take .via`)
      return via(self, impl, ["*"])
    },
  }) as unknown as AnyClaim
  Object.defineProperty(self, "title", { value: title })
  return self
}

function via(claim: AnyClaim, impl: (input: never) => unknown, paths: readonly string[]): AnyVia {
  return { kind: "via", claim, impl, paths, in: ((...p: string[]) => via(claim, impl, p)) as AnyVia["in"] }
}

/** A failed claim: its findings say why. */
export class ClaimFailure extends Error {
  constructor(readonly findings: readonly string[]) {
    super(findings.join("\n"))
  }
}
