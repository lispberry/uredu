// Entry for the single-file binary (`bun build --compile`). A uredu.ts imported at runtime
// can't resolve packages from node_modules, so uredu and the first-party rulesets are
// registered as virtual modules backed by the copies bundled into the binary, along with zod.
import { plugin } from "bun"
import * as game from "@uredu/game"
import * as shipSafely from "@uredu/ship-safely"
import * as kits from "@uredu/ship-safely/kits"
import * as ui from "@uredu/ui"
import * as uredu from "uredu"
import { main } from "uredu/cli"
import * as zod from "zod"

const modules: Record<string, Record<string, unknown>> = {
  uredu,
  zod,
  "@uredu/ship-safely": shipSafely,
  "@uredu/ship-safely/kits": kits,
  "@uredu/game": game,
  "@uredu/ui": ui,
}

plugin({
  name: "uredu",
  setup(build) {
    for (const [name, exports] of Object.entries(modules)) build.module(name, () => ({ exports, loader: "object" }))
  },
})

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: () => Bun.stdin.text(),
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  command: "uredu",
})
