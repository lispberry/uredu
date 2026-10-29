import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll } from "bun:test"

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })))
})

export async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proven-test-"))
  made.push(dir)
  return dir
}

export interface Repo {
  readonly root: string
  write(files: Record<string, string>): Promise<void>
  remove(path: string): Promise<void>
  git(...args: string[]): Promise<string>
  commit(message: string): Promise<string>
}

export async function repo(files: Record<string, string> = {}): Promise<Repo> {
  const root = await tmp()
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
    return out.trim()
  }
  const write = async (fs: Record<string, string>) => {
    for (const [path, content] of Object.entries(fs)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await Bun.write(join(root, path), content)
    }
  }
  await git("init", "-q", "-b", "main")
  await git("config", "user.email", "test@example.com")
  await git("config", "user.name", "Test")
  await git("config", "commit.gpgsign", "false")
  const r: Repo = {
    root,
    write,
    remove: (path) => rm(join(root, path), { recursive: true, force: true }),
    git,
    commit: async (message) => {
      await git("add", "-A")
      await git("commit", "-q", "--allow-empty", "-m", message)
      return git("rev-parse", "HEAD")
    },
  }
  await write({ "README.md": "fixture\n", ...files })
  await r.commit("init")
  return r
}
