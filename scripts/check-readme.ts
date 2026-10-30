// Type-checks every ```ts block in README.md, so the documented API can't drift from the real one.
// Each block compiles on its own; a block that writes a workflow compiles against examples/mixed's project.
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dir = join(root, "examples", ".readme")
const blocks = [...(await Bun.file(join(root, "README.md")).text()).matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)

await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })
let failed = 0
for (const [i, code] of blocks.entries()) {
  const file = join(dir, `block-${i + 1}.ts`)
  await Bun.write(file, code)
  const files = code.includes("workflow(") ? [file, join(root, "examples", "mixed", "uredu.ts")] : [file]
  const config = join(dir, `tsconfig-${i + 1}.json`)
  await Bun.write(config, JSON.stringify({ extends: join(root, "tsconfig.base.json"), compilerOptions: { typeRoots: [join(root, "node_modules", "@types")] }, files }))
  const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", config], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (tsc.exitCode !== 0) {
    failed++
    console.error(`README.md block ${i + 1}:\n${tsc.stdout.toString()}${tsc.stderr.toString()}`)
  }
}
await rm(dir, { recursive: true, force: true })
console.log(`README.md: ${blocks.length - failed} of ${blocks.length} ts blocks compile`)
process.exitCode = failed ? 1 : 0
