// Where areas live: the project's located providers map directories (and globs inside them) to areas,
// and say which provider binds each proof in each directory. Later providers override earlier ones.
import type { AnyArea, SymbolMatcher } from "../area.ts"
import type { Binding } from "../proof.ts"
import type { AnyLocated, Provider } from "../provider.ts"

export interface Placement {
  readonly dir: string
  readonly area: AnyArea
}

export interface Bound {
  readonly dir: string
  readonly provider: Provider
  readonly binding: Binding
}

const normalize = (dir: string) => dir.replace(/^\.\//, "").replace(/\/+$/, "") || "."

export function inDir(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`)
}

export function relative(path: string, dir: string): string {
  return dir === "." ? path : path.slice(dir.length + 1)
}

export class Layout {
  readonly placements: readonly Placement[]

  constructor(readonly located: readonly AnyLocated[]) {
    this.placements = located.flatMap((l) => l.dirs.flatMap((dir) => l.provider.areas.map((area) => ({ dir: normalize(dir), area }))))
  }

  /** Does `path` belong to the area called `name`? */
  inArea(name: string, path: string): boolean {
    return this.placements.some((p) => p.area.name === name && this.covers(p, path))
  }

  areasOf(path: string): string[] {
    return [...new Set(this.placements.filter((p) => this.covers(p, path)).map((p) => p.area.name))]
  }

  /** Placements of an area that contain `path`, e.g. to find the symbol matcher for a file. */
  placementsFor(name: string, path: string): Placement[] {
    return this.placements.filter((p) => p.area.name === name && this.covers(p, path))
  }

  /** The effective binding of a proof per directory: the last provider listed wins. */
  bindings(proof: string): Bound[] {
    const byDir = new Map<string, Bound>()
    for (const l of this.located)
      for (const binding of l.provider.bindings)
        if (binding.proof.name === proof) for (const dir of l.dirs) byDir.set(normalize(dir), { dir: normalize(dir), provider: l.provider, binding })
    return [...byDir.values()]
  }

  private covers(p: Placement, path: string): boolean {
    if (!inDir(path, p.dir)) return false
    const rel = relative(path, p.dir)
    return p.area.patterns.length === 0 || p.area.patterns.some((g) => new Bun.Glob(g).match(rel))
  }
}

/** Names of symbols in `source` selected by a matcher. */
export function symbolsIn(source: string, matcher: SymbolMatcher): string[] {
  const [kind, name] = matcher.query.split(":") as [string, string]
  if (matcher.toolchain !== "rust" || kind !== "derive") throw new Error(`unsupported symbol matcher: ${matcher.toolchain} ${matcher.query}`)
  const found: string[] = []
  const re = /#\[derive\(([^)]*)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+(\w+)/g
  for (const m of source.matchAll(re)) if (m[1]!.split(",").some((d) => d.trim().split("::").pop() === name)) found.push(m[2]!)
  return found
}
