// `$`: Bun-style shell commands for implementing claims, run by a real `sh` with interpolated values
// quoted. A command runs in the current claim's working directory (the part of the repo, in a worktree at
// the right revision) and fails the claim when it exits non-zero. Readers turn its output into a value.
import { appendFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { storage } from "./context.ts"
import { junitFindings, samples, sarifFindings, testCounts, type TestCounts } from "./engine/parsers.ts"
import { proc } from "./engine/proc.ts"
import { ClaimFailure } from "./claim.ts"

export interface Result {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export class Command implements PromiseLike<void> {
  constructor(
    private readonly strings: TemplateStringsArray,
    private readonly values: readonly unknown[],
    private readonly dir = ".",
  ) {}

  /** Run in another directory, relative to the current one. */
  cwd(dir: string): Command {
    return new Command(this.strings, this.values, isAbsolute(dir) ? dir : join(this.dir, dir))
  }

  get command(): string {
    return this.strings.raw
      .reduce((out, s, i) => out + s + (i < this.values.length ? [this.values[i]].flat().join(" ") : ""), "")
      .replace(/\s+/g, " ")
      .trim()
  }

  private where(): string {
    return resolve(storage.getStore()?.cwd ?? process.cwd(), this.dir)
  }

  /** The command for `sh -c`, with every interpolated value quoted (arrays become several words). */
  get script(): string {
    return this.strings.raw.reduce((out, s, i) => out + s + (i < this.values.length ? [this.values[i]].flat().map(quote).join(" ") : ""), "")
  }

  /** Run and return the exit code and output; never fails. */
  async nothrow(): Promise<Result> {
    const ctx = storage.getStore()
    const result = await proc(["sh", "-c", this.script], { cwd: this.where(), env: ctx?.env })
    if (ctx?.log) await appendFile(ctx.log, `$ ${this.command}\n${result.stdout}${result.stderr}`)
    return result
  }

  private async ok(): Promise<Result> {
    const r = await this.nothrow()
    if (r.code !== 0) throw this.failure(r)
    return r
  }

  private failure(r: Result): ClaimFailure {
    const last = (r.stderr.trim() || r.stdout.trim()).split("\n").pop()
    return new ClaimFailure([`${this.command} exited with ${r.code}${last ? `: ${last}` : ""}`])
  }

  then<A = void, B = never>(onfulfilled?: ((value: void) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.ok().then(() => undefined).then(onfulfilled, onrejected)
  }

  /** Standard output, without the trailing newline. */
  async text(): Promise<string> {
    return (await this.ok()).stdout.trimEnd()
  }

  // oxlint-disable-next-line no-explicit-any -- parsed by the claim's output schema
  async json(): Promise<any> {
    return JSON.parse((await this.ok()).stdout)
  }

  /** Bytes of a file the command wrote, e.g. a screenshot. */
  async file(path: string): Promise<Uint8Array<ArrayBuffer>> {
    await this.ok()
    return new Uint8Array(await Bun.file(join(this.where(), path)).arrayBuffer())
  }

  /** Fails with the failed test cases of a JUnit report the command wrote. */
  async junit(path: string): Promise<void> {
    await this.report(path, junitFindings)
  }

  /** Fails with the results of a SARIF log the command wrote. */
  async sarif(path: string): Promise<void> {
    await this.report(path, sarifFindings)
  }

  /** Test counts from a test runner's summary (bun, cargo, pytest, jest, vitest), whether or not tests failed. */
  async tests(): Promise<TestCounts> {
    const r = await this.nothrow()
    const counts = testCounts(r.stdout + r.stderr)
    if (!counts) throw new ClaimFailure([`${this.command}: no test summary in its output`])
    return counts
  }

  /** Timing samples (ns per iteration) from bencher-format output, e.g. `cargo bench -- --output-format bencher`. */
  async samples(): Promise<number[]> {
    const found = samples((await this.ok()).stdout)
    if (!found.length) throw new ClaimFailure([`${this.command}: no bencher samples in its output`])
    return found
  }

  private async report(path: string, read: (text: string) => string[]): Promise<void> {
    const r = await this.nothrow()
    const file = Bun.file(join(this.where(), path))
    const findings = (await file.exists()) ? read(await file.text()) : [`${this.command} did not write ${path}`]
    if (findings.length) throw new ClaimFailure(findings)
    if (r.code !== 0) throw this.failure(r)
  }
}

const quote = (v: unknown) => {
  const s = String(v)
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}

export function $(strings: TemplateStringsArray, ...values: unknown[]): Command {
  return new Command(strings, values)
}
