// A project: one flat list of claims. Entries without .via are what the project owes; .via entries say how
// it proves the abstract ones. `.in(...)` scopes either to parts of the repo.
//
//   export default project({
//     claims: [shipSafely, ui.in("web"), ...node.in("web"), screenshot.via(…).in("web")],
//   })
//
// An owed claim that reaches an abstract claim without a .via covering its paths does not compile.
import { claim, type AnyClaim, type AnyVia, type NeedsOf, type Owed, type Via } from "./claim.ts"

/** Runs once in every fresh worktree before any other claim: install dependencies, generate files. */
export const ready = claim("Worktree is ready")

export type Entry = AnyClaim | Owed<AnyClaim, string> | AnyVia

export interface ProjectConfig<E extends readonly Entry[]> {
  readonly claims: E
  /** Environment for every command. */
  readonly env?: Readonly<Record<string, string>>
}

export interface Project<Provided extends string = string> {
  readonly kind: "project"
  readonly claims: readonly Entry[]
  readonly env: Readonly<Record<string, string>>
  readonly __provided?: Provided
}

type ViaOf<E> = E extends Via<infer N, infer S> ? readonly [N, S] : never
type Vias<Es extends readonly Entry[]> = ViaOf<Es[number]>
type ProvidedIn<Es extends readonly Entry[], S extends string> =
  Vias<Es> extends infer V ? (V extends readonly [infer N, infer VS] ? (VS extends "*" | S ? N : never) : never) : never
type MissingPairs<Ns, Have, Where extends string> = Ns extends readonly [infer A extends string, infer P extends string]
  ? A extends Have
    ? never
    : `claim '${A}'${P extends "" ? "" : ` (${P})`} has no .via in ${Where}`
  : never
type MissingFor<Es extends readonly Entry[], X> =
  X extends Owed<infer P, infer S>
    ? S extends string
      ? MissingPairs<NeedsOf<P>, ProvidedIn<Es, S>, S>
      : never
    : X extends AnyClaim
      ? MissingPairs<NeedsOf<X>, Vias<Es>[0], "the repo">
      : never
export type Missing<Es extends readonly Entry[]> = MissingFor<Es, Es[number]>
/** `{}` when nothing is missing; otherwise an object whose keys are the errors, which no config satisfies. */
export type Check<M extends string> = [M] extends [never] ? unknown : { readonly [K in M]: never }

export type ProvidedBy<Es extends readonly Entry[]> = Vias<Es>[0]

export function project<const E extends readonly Entry[]>(config: ProjectConfig<E> & NoInfer<Check<Missing<E>>>): Project<ProvidedBy<E>> {
  for (const e of config.claims)
    if (!e || (e.kind !== "claim" && e.kind !== "owed" && e.kind !== "via")) throw new Error("project: claims must be claims, .in(...) or .via(...) entries")
  return { kind: "project", claims: config.claims, env: config.env ?? {} }
}
