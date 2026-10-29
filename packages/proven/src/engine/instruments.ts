// Executing an instrument in a directory and reading its verdict.
import { cp, mkdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import type { Finding, Verdict } from "../expect.ts"
import type { Instrument } from "../instrument.ts"
import { findingsWith, junitFindings, samplesWith, sarifFindings } from "./parsers.ts"
import { proc, type ProcResult } from "./proc.ts"

export interface ExecOptions {
  readonly cwd: string
  /** Where this run keeps its log and artifacts. */
  readonly runDir: string
  readonly signal: AbortSignal
  readonly env?: Readonly<Record<string, string>>
}

const fail = (message: string): Verdict => ({ ok: false, findings: [{ message, severity: "error" }], artifacts: [] })

export async function execute(instrument: Instrument, opts: ExecOptions): Promise<Verdict> {
  await mkdir(opts.runDir, { recursive: true })
  const result = await launch(instrument, opts)
  if (typeof result === "string") return fail(result)
  await Bun.write(join(opts.runDir, "log"), `$ ${describe(instrument)}\n${result.stdout}${result.stderr}`)
  return read(instrument, result, opts)
}

export function describe(instrument: Instrument): string {
  const s = instrument.spec.source
  switch (s.kind) {
    case "sh":
      return s.command
    case "script":
      return `script ${s.name}`
    case "http":
      return `${s.method} ${s.url}`
    case "hook":
      return s.path
    case "preCommit":
      return `pre-commit ${s.id}`
    case "builtin":
      return `builtin ${s.name}`
  }
}

/** Run the instrument's source. Returns an error message when it cannot be started at all. */
async function launch(instrument: Instrument, opts: ExecOptions): Promise<ProcResult | string> {
  const s = instrument.spec.source
  const run = (argv: string[]) => proc(argv, { cwd: opts.cwd, signal: opts.signal, env: opts.env })
  switch (s.kind) {
    case "sh":
      return run(["sh", "-c", s.command])
    case "script": {
      const argv = await scriptCommand(opts.cwd, s.name)
      return argv ? run(argv) : `no script "${s.name}" in package.json, Makefile or justfile at ${opts.cwd}`
    }
    case "hook":
      return run([resolve(opts.cwd, s.path)])
    case "preCommit":
      return run(["pre-commit", "run", s.id, "--all-files"])
    case "http": {
      const res = await fetch(s.url, { signal: opts.signal }).catch((e: Error) => e)
      if (res instanceof Error) return `GET ${s.url} failed: ${res.message}`
      return { code: res.ok ? 0 : 1, stdout: await res.text(), stderr: res.ok ? "" : `HTTP ${res.status}\n` }
    }
    case "builtin":
      return `builtin "${s.name}" is not implemented yet`
  }
}

async function scriptCommand(cwd: string, name: string): Promise<string[] | undefined> {
  const pkg = Bun.file(join(cwd, "package.json"))
  if (await pkg.exists()) {
    const scripts = ((await pkg.json()) as { scripts?: Record<string, string> }).scripts ?? {}
    if (name in scripts) return ["bun", "run", name]
  }
  const target = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m")
  for (const [file, argv] of [
    ["Makefile", ["make", name]],
    ["justfile", ["just", name]],
  ] as const) {
    const f = Bun.file(join(cwd, file))
    if ((await f.exists()) && target.test(await f.text())) return [...argv]
  }
  return undefined
}

async function read(instrument: Instrument, result: ProcResult, opts: ExecOptions): Promise<Verdict> {
  const spec = instrument.spec
  const output = result.stdout + result.stderr
  const findings: Finding[] = []
  let ok = result.code === 0
  if (!ok) {
    const last = result.stderr.trim().split("\n").pop()
    findings.push({ message: `${describe(instrument)} exited with ${result.code}${last ? `: ${last}` : ""}`, severity: "error" })
  }

  if (spec.report) {
    const file = Bun.file(join(opts.cwd, spec.report.path))
    if (!(await file.exists())) {
      ok = false
      findings.push({ message: `report ${spec.report.path} was not written`, severity: "error" })
    } else {
      const reported = spec.report.kind === "junit" ? junitFindings(await file.text()) : sarifFindings(await file.text())
      if (reported.some((f) => f.severity === "error")) ok = false
      findings.push(...reported)
    }
  }

  if (spec.findings) {
    const found = findingsWith(spec.findings.name, output)
    if (found.length) ok = false
    findings.push(...found)
  }

  const value =
    spec.value === undefined ? undefined : spec.value === "stdout" ? result.stdout.trim() : await Bun.file(join(opts.cwd, spec.value.file)).text()
  const samples = spec.samples ? samplesWith(spec.samples.name, output) : undefined
  const artifacts = await collect(spec.artifacts, opts)
  return { ok, value, samples, findings, artifacts }
}

/** Copy artifact paths that exist into the run directory. */
async function collect(paths: readonly string[], opts: ExecOptions): Promise<string[]> {
  const kept: string[] = []
  for (const p of paths) {
    const from = join(opts.cwd, p)
    const exists = await Bun.file(from).exists() || (await proc(["test", "-d", from], { cwd: opts.cwd })).code === 0
    if (!exists) continue
    const to = join(opts.runDir, "artifacts", basename(p))
    await cp(from, to, { recursive: true })
    kept.push(to)
  }
  return kept
}
