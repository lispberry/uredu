// A proof is a named guarantee. Rules expect it; providers bind it to a tool with proof.by(...).
import type { Instrument } from "./instrument.ts"

export type Claim = string | ((args: any) => string)
export type ArgsOf<C> = C extends (args: infer A) => string ? A : void

/** How a provider checks a proof: an instrument, or a function of the proof's arguments. */
export type Prover<A> = [A] extends [void] ? Instrument : (args: A) => Instrument

export interface Proof<N extends string = string, A = any> {
  readonly kind: "proof"
  readonly name: N
  readonly claim: Claim
  /** phantom: argument type */
  readonly __args?: A
  /** Bind this proof to a tool, e.g. testsPass.by(sh`cargo nextest run`). */
  by(prover: Prover<A>): Binding<N>
}

export interface Binding<N extends string = string> {
  readonly kind: "binding"
  readonly proof: AnyProof
  readonly prover: Instrument | ((args: any) => Instrument)
  readonly __proof?: N
}

export type AnyProof = Proof<string, any>

export function proofs<const D extends Record<string, Claim>>(defs: D): { [K in keyof D & string]: Proof<K, ArgsOf<D[K]>> } {
  const out: Record<string, AnyProof> = {}
  for (const [name, claim] of Object.entries(defs)) {
    const proof: AnyProof = { kind: "proof", name, claim, by: (prover) => ({ kind: "binding", proof, prover }) }
    out[name] = proof
  }
  return out as any
}

export function claimOf(proof: AnyProof, args?: unknown): string {
  return typeof proof.claim === "string" ? proof.claim : proof.claim(args)
}
