// Hooks: the same rules gate git commits and coding agents. `proven hook pre-commit` checks what is
// staged; `proven hook claude` handles Claude Code hook events read from stdin.
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { format } from "./format.ts"
import { Git } from "./git.ts"
import { proc } from "./proc.ts"
import { Session, type SessionOptions } from "./session.ts"

export interface HookResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export const sessionRef = "refs/proven/session"
/** After this many blocked stops in a row, let the agent stop and hand over to a human. */
export const stopBlockCap = 5

export async function preCommit(options: Omit<SessionOptions, "head" | "base">): Promise<HookResult> {
  const session = await Session.open({ ...options, head: "index" })
  const report = await session.run()
  return { code: report.ok ? 0 : 1, stdout: "", stderr: report.ok ? "" : `${format(report)}\n\ncommit blocked by proven\n` }
}

interface ClaudeInput {
  readonly hook_event_name: string
  readonly stop_hook_active?: boolean
}

const context = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

export async function claude(input: string, options: Omit<SessionOptions, "head" | "base">): Promise<HookResult> {
  const event = (JSON.parse(input) as ClaudeInput).hook_event_name
  const git = await Git.open(options.cwd)
  const started = (await proc(["git", "rev-parse", "--verify", "--quiet", sessionRef], { cwd: git.root })).code === 0

  if (event === "SessionStart") {
    await git.git("update-ref", sessionRef, "HEAD")
    await Bun.write(git.store("stop-blocks"), "0")
    const report = await (await Session.open({ ...options, base: "HEAD" })).plan()
    return { code: 0, stdout: context(event, `This repo gates work with proven. Rules for the current change:\n${format(report)}`), stderr: "" }
  }

  const session = await Session.open({ ...options, base: started ? sessionRef : "HEAD" })
  if (event === "PostToolUse") {
    const report = await session.plan()
    return { code: 0, stdout: context(event, `proven: proofs now owed by this change:\n${format(report, { onlyFired: true })}`), stderr: "" }
  }

  if (event === "TaskCompleted" || event === "Stop") {
    const report = await session.run()
    const blocks = Number(await Bun.file(git.store("stop-blocks")).text().catch(() => "0"))
    if (report.ok) {
      await Bun.write(git.store("stop-blocks"), "0")
      return { code: 0, stdout: "", stderr: "" }
    }
    if (event === "Stop" && blocks >= stopBlockCap)
      return { code: 0, stdout: "", stderr: `proven: proofs still fail after ${blocks} attempts; a human needs to look.\n${format(report)}\n` }
    if (event === "Stop") await Bun.write(git.store("stop-blocks"), String(blocks + 1))
    return { code: 2, stdout: "", stderr: `${format(report, { onlyFired: true })}\n\nproven: not done; these proofs must pass first.\n` }
  }

  return { code: 0, stdout: "", stderr: "" }
}

// ── install ──────────────────────────────────────────────────────────────────

interface HookCommand {
  readonly type: "command"
  readonly command: string
}
interface HookEntry {
  readonly matcher?: string
  readonly hooks: HookCommand[]
}
interface Settings {
  hooks?: Record<string, HookEntry[]>
  permissions?: { deny?: string[] }
  [key: string]: unknown
}

export const claudeEvents: readonly (readonly [string, string | undefined])[] = [
  ["SessionStart", undefined],
  ["PostToolUse", "Edit|Write|MultiEdit"],
  ["TaskCompleted", undefined],
  ["Stop", undefined],
]

export const denyRules = ["Edit(proven.ts)", "Write(proven.ts)", "Edit(**/proven.ts)", "Write(**/proven.ts)", "Bash(git update-ref refs/proven/*)"]

/** Merge Proven's hooks and deny rules into .claude/settings.json, keeping everything else. */
export async function installClaude(root: string, command: string): Promise<string> {
  const path = join(root, ".claude", "settings.json")
  const file = Bun.file(path)
  const settings: Settings = (await file.exists()) ? ((await file.json()) as Settings) : {}
  const hooks = (settings.hooks ??= {})
  const hookCommand = `${command} hook claude`
  for (const [event, matcher] of claudeEvents) {
    const entries = (hooks[event] ??= [])
    if (entries.some((e) => e.hooks.some((h) => h.command === hookCommand))) continue
    entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand }] })
  }
  const deny = ((settings.permissions ??= {}).deny ??= [])
  for (const rule of denyRules) if (!deny.includes(rule)) deny.push(rule)
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  return path
}

const marker = "# installed by proven"

/** Install the git pre-commit hook. Refuses to replace a hook Proven did not write unless forced. */
export async function installPreCommit(git: Git, command: string, force = false): Promise<string> {
  const path = join(git.dir, "hooks", "pre-commit")
  const existing = Bun.file(path)
  if ((await existing.exists()) && !(await existing.text()).includes(marker) && !force)
    throw new Error(`${path} exists and was not written by proven; pass --force to replace it`)
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `#!/bin/sh\n${marker}\nexec ${command} hook pre-commit\n`)
  await chmod(path, 0o755)
  return path
}
