// Reading tool output. Parsers turn what existing tools print into findings and samples; they never
// reimplement the tools themselves.
import type { Finding } from "../expect.ts"

/** Timing samples (ns) from `cargo bench -- --output-format bencher` / criterion's bencher output. */
function bencher(output: string): number[] {
  return [...output.matchAll(/bench:\s+([\d,.]+) ns\/iter/g)].map((m) => Number(m[1]!.replace(/,/g, "")))
}

/** Crashes from cargo fuzz / libFuzzer output, with the crash input as reproducer. */
function cargoFuzz(output: string): Finding[] {
  const panic = /panicked at ([^:\s]+):(\d+):\d+:\n(.+)/.exec(output)
  const error = /ERROR: libFuzzer: (.+)/.exec(output)
  const input = /Test unit written to (\S+)/.exec(output)?.[1]
  if (!panic && !error) return []
  return [
    {
      message: panic ? panic[3]!.trim() : error![1]!.trim(),
      location: panic ? { file: panic[1]!, line: Number(panic[2]) } : undefined,
      reproducer: input,
      severity: "error",
    },
  ]
}

const samplers: Record<string, (output: string) => number[]> = { bencher, criterion: bencher }
const finders: Record<string, (output: string) => Finding[]> = { "cargo-fuzz": cargoFuzz }

export function samplesWith(name: string, output: string): number[] {
  const f = samplers[name]
  if (!f) throw new Error(`unknown samples parser: ${name}`)
  return f(output)
}

export function findingsWith(name: string, output: string): Finding[] {
  const f = finders[name]
  if (!f) throw new Error(`unknown findings parser: ${name}`)
  return f(output)
}

const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1]

/** Failed and errored test cases from a JUnit XML report. */
export function junitFindings(xml: string): Finding[] {
  const findings: Finding[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const failure = /<(failure|error)\b([^>]*)/.exec(m[2] ?? "")
    if (!failure) continue
    const name = [attr(m[1]!, "classname"), attr(m[1]!, "name")].filter(Boolean).join(" › ")
    const file = attr(m[1]!, "file")
    findings.push({
      message: `${name}: ${attr(failure[2]!, "message") ?? failure[1]}`,
      location: file ? { file } : undefined,
      severity: "error",
    })
  }
  return findings
}

interface SarifResult {
  readonly level?: string
  readonly message?: { readonly text?: string }
  readonly locations?: readonly { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[]
}

/** Results from a SARIF log. */
export function sarifFindings(json: string): Finding[] {
  const log = JSON.parse(json) as { runs?: { results?: SarifResult[] }[] }
  return (log.runs ?? []).flatMap((run) =>
    (run.results ?? []).map((r): Finding => {
      const loc = r.locations?.[0]?.physicalLocation
      return {
        message: r.message?.text ?? "(no message)",
        location: loc?.artifactLocation?.uri ? { file: loc.artifactLocation.uri, line: loc.region?.startLine } : undefined,
        severity: r.level === "warning" ? "warning" : r.level === "note" ? "note" : "error",
      }
    }),
  )
}
