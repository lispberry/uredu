// Instruments are how a prover reaches existing tools: a shell command, a package script, an HTTP endpoint,
// an existing hook script. Every instrument ends in the same verdict shape; these modifiers say how to read it.

export type Source =
  | { readonly kind: "sh"; readonly command: string }
  | { readonly kind: "script"; readonly name: string }
  | { readonly kind: "http"; readonly method: "GET"; readonly url: string }
  | { readonly kind: "hook"; readonly path: string }
  | { readonly kind: "preCommit"; readonly id: string }
  | { readonly kind: "builtin"; readonly name: string; readonly options: Readonly<Record<string, unknown>> }

export type Report = { readonly kind: "junit" | "sarif"; readonly path: string }
export type Parser = { readonly kind: "parser"; readonly name: string }
export type ValueFrom = "stdout" | { readonly file: string }

export interface InstrumentSpec {
  readonly source: Source
  readonly report: Report | undefined
  readonly value: ValueFrom | undefined
  readonly samples: Parser | undefined
  readonly artifacts: readonly string[]
  readonly findings: Parser | undefined
}

export interface Instrument {
  readonly kind: "instrument"
  readonly spec: InstrumentSpec
  /** Read pass/fail and findings from a JUnit or SARIF file instead of the exit code alone. */
  report(report: Report): Instrument
  /** The comparable value for `toMatch`. */
  value(from: ValueFrom): Instrument
  /** Timing samples for `toBeFaster`. */
  samples(parser: Parser): Instrument
  /** Files the runner keeps with the run, e.g. crash inputs. */
  artifacts(...paths: string[]): Instrument
  /** Turn tool output into findings with locations and reproducers. */
  findings(parser: Parser): Instrument
}

function instrument(spec: InstrumentSpec): Instrument {
  return {
    kind: "instrument",
    spec,
    report: (report) => instrument({ ...spec, report }),
    value: (value) => instrument({ ...spec, value }),
    samples: (samples) => instrument({ ...spec, samples }),
    artifacts: (...paths) => instrument({ ...spec, artifacts: [...spec.artifacts, ...paths] }),
    findings: (findings) => instrument({ ...spec, findings }),
  }
}

const from = (source: Source) =>
  instrument({ source, report: undefined, value: undefined, samples: undefined, artifacts: [], findings: undefined })

export function sh(strings: TemplateStringsArray, ...values: unknown[]): Instrument {
  return from({ kind: "sh", command: String.raw({ raw: strings }, ...values.map(String)) })
}

/** A package.json, Makefile or justfile target. */
export const script = (name: string) => from({ kind: "script", name })
export const http = { get: (url: string) => from({ kind: "http", method: "GET", url }) }
/** An existing agent or git hook script; exit 0 passes. */
export const hook = (path: string) => from({ kind: "hook", path })
/** A hook id from .pre-commit-config.yaml. */
export const preCommit = (id: string) => from({ kind: "preCommit", id })
/** Proofs the runner implements itself, for kits (e.g. comparing test inventories across revisions). */
export const builtin = (name: string, options: Record<string, unknown> = {}) => from({ kind: "builtin", name, options })

export const junit = (path: string): Report => ({ kind: "junit", path })
export const sarif = (path: string): Report => ({ kind: "sarif", path })
export const parser = (name: string): Parser => ({ kind: "parser", name })
