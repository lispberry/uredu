// Entry for the single-file binary (`bun build --compile`). A provenfile imported at runtime
// can't resolve "proven" from node_modules, so every public entry point is registered as a
// virtual module backed by the copy bundled into the binary.
import { plugin } from "bun"
import * as kits from "./kits/index.ts"
import * as proven from "./index.ts"
import * as proofs from "./proofs.ts"
import * as rules from "./rules/index.ts"
import * as lockstep from "./rules/lockstep.ts"
import * as shipSafely from "./rules/ship-safely.ts"
import { main } from "./cli.ts"

const modules: Record<string, Record<string, unknown>> = {
  proven,
  "proven/proofs": proofs,
  "proven/rules": rules,
  "proven/rules/ship-safely": shipSafely,
  "proven/rules/lockstep": lockstep,
  "proven/kits": kits,
}

plugin({
  name: "proven",
  setup(build) {
    for (const [name, exports] of Object.entries(modules)) build.module(name, () => ({ exports, loader: "object" }))
  },
})

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: () => Bun.stdin.text(),
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  command: "proven",
})
