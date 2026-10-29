// project({ rules, providers }) wires everything explicitly. It compiles only if every (area, proof)
// pair the rules require is covered by a located provider:
//
//   error: Property 'proof 'bench' is missing for area 'simulation' (required by "No frame-time regression")' is missing ...
import type { AnyRule, Anywhere, Req, Rule } from "./rule.ts"
import type { AnyLocated, Located } from "./provider.ts"
import type { Instrument } from "./instrument.ts"

type ReqsOfRules<Rs extends readonly AnyRule[]> = { [I in keyof Rs]: Rs[I] extends Rule<infer R> ? R : never }[number]
type AreasOf<Ls extends readonly AnyLocated[]> = { [I in keyof Ls]: Ls[I] extends Located<infer A, any> ? A : never }[number]
type ProofsOf<Ls extends readonly AnyLocated[]> = { [I in keyof Ls]: Ls[I] extends Located<any, infer P> ? P : never }[number]
type PairsOf<Ls extends readonly AnyLocated[]> = {
  [I in keyof Ls]: Ls[I] extends Located<infer A, infer P> ? `${A}::${P}` : never
}[number]

type Missing<R, Ls extends readonly AnyLocated[]> = R extends Req<infer A, infer P, infer T>
  ? A extends Anywhere
    ? P extends ProofsOf<Ls>
      ? never
      : `proof '${P}' has no provider (required by "${T}")`
    : A extends AreasOf<Ls>
      ? `${A}::${P}` extends PairsOf<Ls>
        ? never
        : `proof '${P}' is missing for area '${A}' (required by "${T}")`
      : `area '${A}' has no provider (required by "${T}")`
  : never

/** Each missing requirement becomes a required property named after it, so tsc lists them by name. */
export type Coverage<M extends string> = [M] extends [never] ? unknown : { readonly [K in M]: never }

export interface ProjectConfig<Rs extends readonly AnyRule[] = readonly AnyRule[], Ls extends readonly AnyLocated[] = readonly AnyLocated[]> {
  readonly rules: Rs
  readonly providers: Ls
  /** Run once in every fresh worktree before any proof, e.g. sh`bun install --frozen-lockfile`. */
  readonly setup?: Instrument
  /** Environment for every prover, e.g. a shared CARGO_TARGET_DIR. */
  readonly env?: Readonly<Record<string, string>>
}

export interface Project<P extends string = string> {
  readonly kind: "project"
  readonly rules: readonly AnyRule[]
  readonly providers: readonly AnyLocated[]
  readonly setup: Instrument | undefined
  readonly env: Readonly<Record<string, string>>
  /** phantom: proofs this project can prove, used to type workflow expectations */
  readonly __proofs?: P
}

export function project<const Rs extends readonly AnyRule[], const Ls extends readonly AnyLocated[]>(
  config: ProjectConfig<Rs, Ls> & Coverage<Missing<ReqsOfRules<Rs>, Ls>>,
): Project<ProofsOf<Ls>> {
  return { kind: "project", rules: config.rules, providers: config.providers, setup: config.setup, env: config.env ?? {} }
}
