// Human-readable reports, for terminals, git hooks and agent context.
import type { Node } from "../context.ts"
import type { Report } from "./session.ts"

const marks: Record<Node["status"], string> = { passed: "✓", failed: "✗", owed: "○", missing: "✗" }

export interface FormatOptions {
  /** Leave out claims the change doesn't owe, for agent context. */
  readonly onlyOwed?: boolean
}

const inputOf = (n: Node) => (n.input && typeof n.input === "object" && Object.keys(n.input).length ? ` ${JSON.stringify(n.input)}` : "")

export function format(report: Report, opts: FormatOptions = {}): string {
  const lines = [`uredu ${report.base.slice(0, 7)}..${report.head.slice(0, 7)}`]
  const node = (n: Node, depth: number, reason?: string) => {
    const pad = "  ".repeat(depth)
    const part = depth === 0 && n.part !== "." ? `  [${n.part}]` : ""
    const at = n.at ? ` at ${n.at}` : ""
    const notes = [n.fail ? "must fail" : "", n.cached ? "cached" : "", reason ?? ""].filter(Boolean)
    lines.push(`${pad}${marks[n.status]} ${n.title}${inputOf(n)}${at}${part}${notes.length ? `  (${notes.join(", ")})` : ""}`)
    for (const f of n.findings) lines.push(`${pad}    ${f}`)
    // passing claims stay one line in a run; plans show everything that's owed
    if (report.planned || n.status !== "passed") for (const c of n.children) node(c, depth + 1)
  }
  for (const p of report.claims) node(p, 0, p.reason)
  if (!opts.onlyOwed) for (const i of report.idle) lines.push(`· ${i.title}  (${i.reason})`)
  const leaves = (n: Node): Node[] => (n.children.length ? n.children.flatMap(leaves) : [n])
  if (report.planned) {
    const all = report.claims.flatMap(leaves)
    const missing = all.filter((n) => n.status === "missing").length
    lines.push(`${all.length} claim(s) owed${missing ? `, ${missing} not provided` : ""}`)
  } else {
    const failed = report.claims.filter((p) => p.status !== "passed").length
    lines.push(`${report.claims.length - failed} passed, ${failed} failed`)
  }
  return lines.join("\n")
}
