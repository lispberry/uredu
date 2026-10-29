// provide(area, ...bindings) says how an area proves things. It has no paths: the project places it
// with .at(...). One provider may cover several proofs and several areas.
//
//   export default provide(simulation,
//     deterministic.by(({ runs }) => sh`./tools/replay-hash.sh --runs ${runs}`),
//     output.by(({ workload }) => sh`cargo run -p sim -- replay ${workload}`.value("stdout")),
//   )
import type { AnyArea } from "./area.ts"
import type { Binding } from "./proof.ts"

export interface ProviderData {
  readonly kind: "provider"
  readonly areas: readonly AnyArea[]
  readonly bindings: readonly Binding[]
}

export interface Provider<A extends string = string, P extends string = string> extends ProviderData {
  readonly __areas?: A
  readonly __proofs?: P
  /** Place this provider at one or more directories of the repo. */
  at(...dirs: [string, ...string[]]): Located<A, P>
}

export interface Located<A extends string = string, P extends string = string> {
  readonly kind: "located"
  readonly provider: Provider<A, P>
  readonly dirs: readonly string[]
  readonly __areas?: A
  readonly __proofs?: P
}

export type AnyLocated = Located<string, string>

type AreaNames<X> = X extends readonly AnyArea[] ? X[number]["name"] : X extends AnyArea ? X["name"] : never
type ProofNames<Bs extends readonly Binding[]> = Bs[number] extends Binding<infer N> ? N : never

export function provide<const X extends AnyArea | readonly AnyArea[], const Bs extends readonly Binding[]>(
  areas: X,
  ...bindings: Bs
): Provider<AreaNames<X>, ProofNames<Bs>> {
  const list = (Array.isArray(areas) ? areas : [areas]) as readonly AnyArea[]
  const seen = new Set<string>()
  for (const b of bindings) {
    if (seen.has(b.proof.name)) throw new Error(`provide(${list.map((a) => a.name)}): ${b.proof.name} is bound twice`)
    seen.add(b.proof.name)
  }
  const provider: Provider<any, any> = {
    kind: "provider",
    areas: list,
    bindings,
    at: (...dirs) => ({ kind: "located", provider, dirs }),
  }
  return provider
}
