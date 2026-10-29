// An area is a portable name for a part of a codebase ("simulation", "network message").
// Rules mention areas; providers say how an area proves things and which files in their directory
// belong to it; the project says where the directory is.

export interface SymbolMatcher {
  readonly kind: "symbols"
  readonly toolchain: string
  readonly query: string
}

export interface Area<N extends string = string> {
  readonly kind: "area"
  readonly name: N
  /** Globs, relative to the provider's directory, selecting the area's files. All files when empty. */
  readonly patterns: readonly string[]
  readonly symbols: SymbolMatcher | undefined
  /** Narrow the area to files matching these globs, e.g. tests.matching("tests/**", "**\/*.test.ts"). */
  matching(...patterns: string[]): Area<N>
  /** Narrow the area to symbols, e.g. structs deriving NetMessage. */
  where(symbols: SymbolMatcher): Area<N>
  /** Forecast: this step adds the named symbol to the area. */
  added(symbol: string): AreaChange<N>
}

export interface AreaChange<N extends string = string> {
  readonly kind: "areaChange"
  readonly area: Area<N>
  readonly op: "added"
  readonly symbol: string
}

export type AnyArea = Area<string>

export function area<const N extends string>(name: N): Area<N> {
  return make(name, [], undefined)
}

function make<N extends string>(name: N, patterns: readonly string[], symbols: SymbolMatcher | undefined): Area<N> {
  const self: Area<N> = {
    kind: "area",
    name,
    patterns,
    symbols,
    matching: (...more) => make(name, [...patterns, ...more], symbols),
    where: (s) => make(name, patterns, s),
    added: (symbol) => ({ kind: "areaChange", area: self, op: "added", symbol }),
  }
  return self
}

/** Built-in areas every toolchain kit understands. */
export const code = area("code")
export const tests = area("tests")
