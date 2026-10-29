// Human-readable reports, for terminals, git hooks and agent context.
import type { ExpectationReport, Report, RuleReport } from "./session.ts"

const mark = (e: ExpectationReport) => (e.verdict.planned ? (e.verdict.ok ? "○" : "✗") : e.verdict.ok ? "✓" : "✗")

function all(r: RuleReport): ExpectationReport[] {
  return [...r.expectations, ...r.children.flatMap(all)]
}

function ruleMark(r: RuleReport): string {
  if (r.waived !== undefined) return "⊘"
  if (!r.fired) return "·"
  const es = all(r)
  if (es.some((e) => !e.verdict.ok)) return "✗"
  return es.some((e) => e.verdict.planned) ? "○" : "✓"
}

export interface FormatOptions {
  /** Only rules that fired (and their failures), for agent context. */
  readonly onlyFired?: boolean
}

export function format(report: Report, opts: FormatOptions = {}): string {
  const lines = [`proven ${report.base.slice(0, 7)}..${report.head.slice(0, 7)}`]
  const rule = (r: RuleReport, depth: number) => {
    if (opts.onlyFired && !r.fired) return
    const pad = "  ".repeat(depth)
    lines.push(`${pad}${ruleMark(r)} ${r.title}  (${r.reason})`)
    for (const e of r.expectations) {
      const at = e.at && e.at !== "head" ? ` at ${e.at}` : ""
      const dirs = e.dirs.length ? `  [${e.dirs.join(", ")}]` : ""
      lines.push(`${pad}    ${mark(e)} ${e.claim} — ${e.matcher}${at}${dirs}`)
      for (const f of e.verdict.findings) {
        const loc = f.location ? ` ${f.location.file}${f.location.line ? `:${f.location.line}` : ""}` : ""
        lines.push(`${pad}        ${f.severity}:${loc} ${f.message}${f.reproducer ? `  (reproduce: ${f.reproducer})` : ""}`)
      }
    }
    for (const c of r.children) rule(c, depth + 1)
  }
  for (const r of report.rules) rule(r, 0)
  const es = report.rules.flatMap(all)
  const failed = es.filter((e) => !e.verdict.ok).length
  const planned = es.filter((e) => e.verdict.planned).length
  lines.push(
    planned === es.length
      ? `${es.length} proof(s) owed${failed ? `, ${failed} without a provider` : ""}`
      : `${es.length - failed} passed, ${failed} failed`,
  )
  return lines.join("\n")
}
