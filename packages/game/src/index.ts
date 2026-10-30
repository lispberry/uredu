// Game: claims for a real-time multiplayer game. Portable: no engines, tools or paths. Projects provide
// the abstract claims (frame time, replays, network messages) with their own tooling.
import { z } from "zod"
import { claim, git, all, fail, same } from "uredu"
import { shipSafely } from "@uredu/ship-safely"

const ms = z.number().positive()

/** Frame-time statistics for a scene, with the hottest stacks (most self-time first). */
export const frameTime = claim("Frame time", { scene: z.string() }, { p50: ms, p99: ms, hottest: z.array(z.string()) })
/** Simulation state printed after replaying a recorded workload. */
export const replay = claim("Replay output", { workload: z.string() }, z.string())
/** Hashes of the final simulation state over several runs of the same replay. */
export const replayHashes = claim("Replay hashes", { runs: z.number().int().min(2) }, z.array(z.string()))
/** Network message types the change touches. */
export const messages = claim("Network messages", {}, z.array(z.string()))
export const roundTrip = claim("Message round trip", { message: z.string() })
/** Crashes found by fuzzing a message decoder, deduplicated by signature. */
export const fuzz = claim("Fuzz", { target: z.string(), minutes: z.number().positive() }, z.array(z.object({ signature: z.string(), input: z.string() })))

export const deterministic = claim("Simulation is deterministic", async () => {
  if (!(await git.changed()).length) return
  const hashes = await replayHashes({ runs: 10 })
  if (new Set(hashes).size > 1) fail(`replays diverged: ${[...new Set(hashes)].join(", ")}`)
}, [replayHashes])

export const replaysUnchanged = claim("Replays are unchanged", async () => {
  if (!(await git.changed()).length) return
  same(await replay({ workload: "replays" }), await replay.at(git.mergeBase("main"))({ workload: "replays" }), "replay")
}, [replay])

export const noFrameRegression = claim("No frame-time regression", async () => {
  if (!(await git.changed()).length) return
  const [now, before] = await Promise.all([frameTime({ scene: "benchmark" }), frameTime.at(git.mergeBase("main"))({ scene: "benchmark" })])
  if (now.p99 > before.p99 * 1.05) fail(`p99 frame time ${before.p99} → ${now.p99} ms; hottest: ${now.hottest[0] ?? "unknown"}`)
}, [frameTime])

export const safeMessages = claim("Every network message is safe", async () => {
  await all(await messages(), async (message) => {
    await roundTrip({ message }) // fuzzing a message that doesn't even round-trip wastes the fuzzing budget
    const crashes = await fuzz({ target: message, minutes: 30 })
    if (crashes.length) fail(crashes.map((c) => `${message}: ${c.signature} (input ${c.input})`))
  })
}, [messages, roundTrip, fuzz])


export const game = claim("Game", [shipSafely, deterministic, replaysUnchanged, noFrameRegression, safeMessages])
