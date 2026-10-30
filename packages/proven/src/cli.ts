// The `proven` CLI. `main` takes argv and IO so it can be tested in-process; bin.ts wires it to the process.
import cac from "cac"
import { resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import type { Intent } from "./facts.ts"
import type { Workflow } from "./workflow.ts"
import { format } from "./engine/format.ts"
import { Git } from "./engine/git.ts"
import { claude, installClaude, installPreCommit, preCommit } from "./engine/hooks.ts"
import { Session, type Report } from "./engine/session.ts"

export interface IO {
  readonly cwd: string
  readonly stdin: () => Promise<string>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  /** How installed hooks invoke proven; the standalone binary passes "proven". */
  readonly command?: string
}

interface Flags {
  readonly base?: string
  readonly intent?: Intent
  readonly declare?: string | string[]
  readonly json?: boolean
  readonly workflow?: string
  readonly step?: string
  readonly cache?: boolean
  readonly command?: string
  readonly force?: boolean
}

const intents: readonly Intent[] = ["change", "design", "fix", "refactor", "optimize", "review"]

export async function main(argv: readonly string[], io: IO): Promise<number> {
  let code = 0
  const cli = cac("proven")

  const task = (f: Flags) => {
    if (f.intent && !intents.includes(f.intent)) throw new Error(`--intent must be one of ${intents.join(", ")}`)
    return { intent: f.intent ?? "change", declares: f.declare === undefined ? [] : [f.declare].flat() }
  }
  const show = (report: Report, f: Flags) => io.out(f.json ? JSON.stringify(report, null, 2) : format(report))

  cli
    .command("plan", "What the current change owes: rules, why they fired, proofs and where they run")
    .option("--base <rev>", "Revision the change is measured from", { default: "HEAD" })
    .option("--intent <intent>", `Task intent: ${intents.join(" | ")}`)
    .option("--declare <what>", "Declare something about the task, e.g. 'behaviour change'")
    .option("--workflow <file>", "Plan a workflow step instead of the current diff")
    .option("--step <id>", "Workflow step id")
    .option("--json", "Machine-readable output")
    .action(async (f: Flags) => {
      if (f.workflow) {
        // the workflow carries its project, so rule references in skips are the same objects
        const wf = ((await import(resolve(io.cwd, f.workflow))) as { default: Workflow }).default
        const step = wf.steps.find((s) => s.id === f.step)
        if (!step) throw new Error(`--step must be one of: ${wf.steps.map((s) => s.id).join(", ")}`)
        const session = await Session.open({ cwd: io.cwd, base: f.base, project: wf.project })
        return show(await session.planStep(wf, step), f)
      }
      show(await (await Session.open({ cwd: io.cwd, base: f.base })).plan({ task: task(f) }), f)
    })

  cli
    .command("run", "Run every proof the current change owes; exit 1 if any fails")
    .option("--base <rev>", "Revision the change is measured from", { default: "HEAD" })
    .option("--intent <intent>", `Task intent: ${intents.join(" | ")}`)
    .option("--declare <what>", "Declare something about the task")
    .option("--no-cache", "Ignore cached verdicts")
    .option("--json", "Machine-readable output")
    .action(async (f: Flags) => {
      const report = await (await Session.open({ cwd: io.cwd, base: f.base, cache: f.cache })).run({ task: task(f) })
      show(report, f)
      code = report.ok ? 0 : 1
    })

  cli.command("hook <event>", "Hook entry: pre-commit | claude (reads the Claude Code hook event from stdin)").action(async (event: string) => {
    const result =
      event === "pre-commit" ? await preCommit({ cwd: io.cwd }) : event === "claude" ? await claude(await io.stdin(), { cwd: io.cwd }) : undefined
    if (!result) throw new Error(`unknown hook: ${event} (expected pre-commit or claude)`)
    if (result.stdout) io.out(result.stdout)
    if (result.stderr) io.err(result.stderr)
    code = result.code
  })

  cli
    .command("init", "Install the git pre-commit hook and Claude Code hooks for this repo")
    .option("--command <cmd>", "How hooks invoke proven", { default: io.command ?? "bunx proven" })
    .option("--force", "Replace an existing pre-commit hook")
    .action(async (f: Flags) => {
      const git = await Git.open(io.cwd)
      io.out(`wrote ${await installPreCommit(git, f.command!, f.force)}`)
      io.out(`wrote ${await installClaude(git.root, f.command!)}`)
    })

  cli.help()
  cli.version(pkg.version)
  try {
    cli.parse(["bun", "proven", ...argv], { run: false })
    if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
      cli.outputHelp()
      return argv.length ? 1 : 0
    }
    await cli.runMatchedCommand()
    return code
  } catch (e) {
    io.err(`proven: ${(e as Error).message}`)
    return 1
  }
}
