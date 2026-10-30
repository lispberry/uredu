// Written by an agent; it has to compile before anything runs. Every step lists the claims it must meet.
import { workflow } from "uredu"
import { game } from "@uredu/game"
import { regression } from "@uredu/ship-safely"
import { ui } from "@uredu/ui"

export default workflow("Players can fire homing missiles", [], ({ step }) => {
  const design = step("Design missiles", [], { produces: ["docs/missiles.md"] })
  const sim = step("Missiles simulate", [game], { after: [design] })
  const hud = step("HUD shows lock-on", [ui, game], { after: [sim] })
  step("Fix: lock-on flickers", [regression, ui], { after: [hud] })
})
