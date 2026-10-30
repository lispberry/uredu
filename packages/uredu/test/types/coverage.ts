// Type-level tests: every @ts-expect-error below must be an error, and everything else must compile.
// Run with `tsc --noEmit -p packages/uredu/test/types`.
import { z } from "zod"
import { $, kit, project, claim, workflow } from "uredu"

const frameTime = claim("Frame time", { scene: z.string() }, { p99: z.number() })
const screenshot = claim("Screenshot", { screen: z.string() }, z.string())
const lint = claim("Lint")
const noRegression = claim("No regression", async () => {
  const now = await frameTime({ scene: "benchmark" })
  return now.p99.toFixed(1)
}, [frameTime])
const looksRight = claim("Looks right", async () => void (await screenshot({ screen: "home" })), [screenshot])
const game = claim("Game", [noRegression])
const ui = claim("UI", [looksRight, lint])

const frames = frameTime.via(({ scene }) => $`tracy-capture ${scene}`.json())
const shots = screenshot.via(({ screen }) => $`shoot ${screen}`.text())
const linting = kit(lint.via(() => $`lint`))

// complete: every abstract claim an owed claim reaches has a .via covering its paths
const config = project({ claims: [game, ui.in("web"), frames, shots.in("web"), ...linting.in("web")] })
// a .via without .in covers every path
project({ claims: [ui.in("api"), screenshot.via(() => $`x`.text()), lint.via(() => $`x`)] })

// @ts-expect-error a group reaching an abstract claim nobody provides
project({ claims: [game] })
// @ts-expect-error a .via in web doesn't cover api
project({ claims: [ui.in("api"), shots.in("web"), ...linting] })
// @ts-expect-error an abstract claim owed directly needs a .via too
project({ claims: [lint] })

// @ts-expect-error inputs have the claim's shape
frameTime.via(({ scene }: { scene: number }) => ({ p99: scene }))
// @ts-expect-error outputs have the claim's shape
frameTime.via(async () => "fast")
// @ts-expect-error a pass/fail claim takes no inputs
lint.via(({ x }: { x: string }) => $`${x}`)

claim("Callers", async () => {
  // @ts-expect-error unknown input
  await frameTime({ scen: "x" })
  // @ts-expect-error missing input
  await frameTime()
  await lint()
  const text: string = await noRegression()
  // @ts-expect-error a derived claim's output is what its body returns
  const wrong: number = await noRegression()
  return [text, wrong]
}, [frameTime, lint, noRegression])

// @ts-expect-error deps must be claims
claim("Bad deps", async () => {}, ["frameTime"])

declare module "uredu" {
  interface Register {
    project: typeof config
  }
}

const unknown = claim("Unknown")

workflow("Players can fire homing missiles", [game], ({ step }) => {
  const sim = step("Missiles simulate", [game])
  step("HUD shows lock-on", [ui, game], { after: [sim] })
  // @ts-expect-error the project provides no claim called Unknown
  step("Unprovided", [unknown])
  // @ts-expect-error reached through a group
  step("Unprovided in a group", [claim("Group", [unknown])])
})

// @ts-expect-error the workflow's own claims are checked too
workflow("Bad", [unknown], () => {})
