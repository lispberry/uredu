// Example domain pack: rules for a lockstep multiplayer game. No languages, no paths.
import { rule, git, task, not, area, askHuman } from "../index.ts"
import { deterministic, output, roundTrips, fuzzClean, bench } from "../proofs.ts"

export const simulation = area("simulation")
export const client = area("client")
export const networkMessage = area("network message")

export const deterministicSim = rule("Simulation is deterministic", {
  when: git.changed(simulation),
  uses: { deterministic },
}, ({ expect }) => {
  expect(deterministic, { runs: 10 }).toPass()
})

export const replaysUnchanged = rule("Replays are unchanged", {
  when: git.changed(simulation).and(not(task.declares("behaviour change"))),
  uses: { output },
}, ({ expect }) => {
  expect(output, { workload: "replays" }).toMatch(git.mergeBase("main"))
})

export const safeMessages = rule("Every network message is safe", {
  each: git.diff(git.base, git.head).symbols(networkMessage),
  uses: { roundTrips, fuzzClean },
}, async ({ expect }, msg) => {
  // fuzzing a message that does not even round-trip wastes 30 minutes
  const roundTrip = await expect(roundTrips, { message: msg }).toPass()
  if (!roundTrip.ok) return
  expect(fuzzClean, { target: msg, minutes: 30 })
    .toPass()
    .timeout("45m")
    .retry({ max: 5, fix: `Fix the crash in ${msg}` })
    .otherwise(askHuman("Fuzzing still crashes after 5 fixes"))
})

export const frameBudget = rule("No frame-time regression", {
  when: git.changed(simulation, client),
  uses: { bench },
}, ({ expect }) => {
  expect(bench, { target: "frame" }).toBeFaster(git.mergeBase("main"), { confidence: 0.95, orEqual: true })
})

export const lockstep = rule("Lockstep game", {
  include: [deterministicSim, replaysUnchanged, safeMessages, frameBudget],
})
