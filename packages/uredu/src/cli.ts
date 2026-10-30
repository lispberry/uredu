// The `uredu` CLI. `main` takes argv and IO so it can be tested in-process; bin.ts wires it to the process.
import cac from "cac"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import type { Workflow } from "./workflow.ts"
import { format } from "./engine/format.ts"
import { Git } from "./engine/git.ts"
import { claude, installClaude, installPreCommit, preCommit } from "./engine/hooks.ts"
import { Session, type Report, type Target } from "./engine/session.ts"

export interface IO {
  readonly cwd: string
  readonly stdin: () => Promise<string>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  /** How installed hooks invoke uredu; the standalone binary passes "uredu". */
  readonly command?: string
}

interface Flags {
  readonly base?: string
  readonly json?: boolean
  readonly workflow?: string
  readonly step?: string
  readonly cache?: boolean
  readonly bisect?: boolean
  readonly command?: string
  readonly force?: boolean
}

export async function main(argv: readonly string[], io: IO): Promise<number> {
  let code = 0
  const cli = cac("uredu")

  const show = (report: Report, f: Flags) => io.out(f.json ? JSON.stringify(report, null, 2) : format(report))
  const target = async (f: Flags): Promise<Target | undefined> => {
    if (!f.workflow) return undefined
    // the real path, so the workflow's `import "./uredu.ts"` is the same module the session loads from the git root
    const workflow = ((await import(await realpath(resolve(io.cwd, f.workflow)))) as { default: Workflow }).default
    const step = workflow.steps.find((s) => s.id === f.step)
    if (!step) throw new Error(`--step must be one of: ${workflow.steps.map((s) => s.id).join(", ")}`)
    return { workflow, step }
  }

  cli
    .command("plan", "What the current change owes: claims, the parts they run in, and why")
    .option("--base <rev>", "Revision the change is measured from", { default: "HEAD" })
    .option("--workflow <file>", "Also owe a workflow step's claims")
    .option("--step <id>", "Workflow step id")
    .option("--json", "Machine-readable output")
    .action(async (f: Flags) => {
      show(await (await Session.open({ cwd: io.cwd, base: f.base })).plan(await target(f)), f)
    })

  cli
    .command("run", "Run every claim the current change owes; exit 1 if any fails")
    .option("--base <rev>", "Revision the change is measured from", { default: "HEAD" })
    .option("--workflow <file>", "Also owe a workflow step's claims")
    .option("--step <id>", "Workflow step id")
    .option("--no-cache", "Ignore cached outputs")
    .option("--no-bisect", "Don't bisect failures across commits")
    .option("--json", "Machine-readable output")
    .action(async (f: Flags) => {
      const report = await (await Session.open({ cwd: io.cwd, base: f.base, cache: f.cache, bisect: f.bisect })).run(await target(f))
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
    .option("--command <cmd>", "How hooks invoke uredu", { default: io.command ?? "bunx uredu" })
    .option("--force", "Replace an existing pre-commit hook")
    .action(async (f: Flags) => {
      const git = await Git.open(io.cwd)
      io.out(`wrote ${await installPreCommit(git, f.command!, f.force)}`)
      io.out(`wrote ${await installClaude(git.root, f.command!)}`)
    })

  cli.help()
  cli.version(pkg.version)
  try {
    cli.parse(["bun", "uredu", ...argv], { run: false })
    if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
      cli.outputHelp()
      return argv.length ? 1 : 0
    }
    await cli.runMatchedCommand()
    return code
  } catch (e) {
    io.err(`uredu: ${(e as Error).message}`)
    return 1
  }
}
