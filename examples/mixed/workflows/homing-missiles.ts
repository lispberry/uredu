import { workflow, git } from "proven"
import { simulation, networkMessage, deterministicSim } from "proven/rules"
import { bench } from "proven/proofs"
import project from "../proven.ts"

export default workflow(project, "Players can fire homing missiles", ({ design, step, review, expect }) => {
  const designed = design("Missile design is written", { produces: ["docs/missiles.md"] })

  const simulates = step("Missiles simulate correctly", {
    after: [designed],
    expects: [simulation],
  })

  const travels = step("MissileSpawn travels over the network", {
    after: [designed],
    expects: [networkMessage.added("MissileSpawn")],
  })

  const hud = step("Player sees missile and lock-on", {
    after: [simulates, travels],
    mustNotTouch: [simulation],
    skip: [{ rule: deterministicSim, why: "Presentation only" }],
  })

  const fast = step("Homing adds no frame time", {
    after: [hud],
    done: [expect(bench, { target: "frame" }).toBeFaster(git.step(designed), { orEqual: true })],
  })

  review("Owner approves", { after: [fast] })
})
