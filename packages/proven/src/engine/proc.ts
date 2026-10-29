// Spawning processes: the only place the engine touches the OS process API.

export interface ProcResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ProcOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/**
 * The parent environment minus GIT_* variables: inside a git hook, git exports GIT_INDEX_FILE, GIT_DIR and
 * friends, which would silently redirect every git command Proven runs (and every prover's).
 */
function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")))
}

export async function proc(argv: readonly string[], opts: ProcOptions): Promise<ProcResult> {
  const child = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: { ...inherited(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/** Like proc, but throws with stderr when the command fails. */
export async function procOk(argv: readonly string[], opts: ProcOptions): Promise<string> {
  const r = await proc(argv, opts)
  if (r.code !== 0) throw new Error(`${argv.join(" ")} failed (${r.code}): ${r.stderr.trim()}`)
  return r.stdout
}
