// Reading tool output. Parsers turn what existing tools print into findings, samples and counts; they
// never reimplement the tools themselves.

/** Timing samples (ns per iteration) from bencher-format output (`cargo bench -- --output-format bencher`). */
export function samples(output: string): number[] {
  return [...output.matchAll(/bench:\s+([\d,.]+) ns\/iter/g)].map((m) => Number(m[1]!.replace(/,/g, "")))
}

export interface TestCounts {
  readonly tests: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

/** Test counts from a runner's summary: bun, cargo, pytest, unittest, jest and vitest. Undefined when there's none. */
export function testCounts(output: string): TestCounts | undefined {
  const ran = /^Ran (\d+) tests?/m.exec(output)
  if (ran) {
    // python's unittest: "Ran 3 tests" then "OK (skipped=1)" or "FAILED (failures=1, errors=1)"
    const n = (key: string) => Number(new RegExp(`${key}=(\\d+)`).exec(output)?.[1] ?? 0)
    const [tests, failed, skipped] = [Number(ran[1]), n("failures") + n("errors"), n("skipped")]
    return { tests, passed: tests - failed - skipped, failed, skipped }
  }
  // jest and vitest also summarise suites; their "Tests" line is the one that counts tests
  const lines = output.split("\n").filter((l) => /^\s*Tests:?\s/.test(l))
  const text = lines.length ? lines.join("\n") : output
  const counts = { passed: 0, failed: 0, skipped: 0 }
  let found = false
  for (const m of text.matchAll(/(\d+)\s+(passed|pass|failed|fail|skipped|skip|ignored|todo)\b/g)) {
    found = true
    const kind = m[2]!.startsWith("pass") ? "passed" : m[2]!.startsWith("fail") ? "failed" : "skipped"
    counts[kind] += Number(m[1])
  }
  return found ? { tests: counts.passed + counts.failed + counts.skipped, ...counts } : undefined
}

const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1]

/** Failed and errored test cases from a JUnit XML report. */
export function junitFindings(xml: string): string[] {
  const findings: string[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const failure = /<(failure|error)\b([^>]*)/.exec(m[2] ?? "")
    if (!failure) continue
    const name = [attr(m[1]!, "classname"), attr(m[1]!, "name")].filter(Boolean).join(" › ")
    const file = attr(m[1]!, "file")
    findings.push(`${name}: ${attr(failure[2]!, "message") ?? failure[1]}${file ? ` (${file})` : ""}`)
  }
  return findings
}

interface SarifResult {
  readonly level?: string
  readonly message?: { readonly text?: string }
  readonly locations?: readonly { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[]
}

/** Error-level results from a SARIF log (warnings and notes don't fail a claim). */
export function sarifFindings(json: string): string[] {
  const log = JSON.parse(json) as { runs?: { results?: SarifResult[] }[] }
  return (log.runs ?? []).flatMap((run) =>
    (run.results ?? [])
      .filter((r) => (r.level ?? "error") === "error")
      .map((r) => {
        const loc = r.locations?.[0]?.physicalLocation
        const where = loc?.artifactLocation?.uri ? ` (${loc.artifactLocation.uri}${loc.region?.startLine ? `:${loc.region.startLine}` : ""})` : ""
        return `${r.message?.text ?? "(no message)"}${where}`
      }),
  )
}
