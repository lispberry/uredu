import { describe, expect as assert, test } from "bun:test"
import { $, project, Session, type Node, type Project } from "uredu"
import { repo } from "../../uredu/test/helpers.ts"
import { deterministic, frameTime, fuzz, game, messages, noFrameRegression, replay, replayHashes, replaysUnchanged, roundTrip, safeMessages } from "../src/index.ts"

// the "game" is a few files the implementations read
const impls = [
  frameTime.via(({ scene }) => $`cat frames/${scene}.json`.json()),
  replay.via(({ workload }) => $`cat ${workload}.txt`.text()),
  replayHashes.via(async ({ runs }) => Array.from({ length: runs }, (_, i) => (i === runs - 1 ? "h-last" : "h"))),
  messages.via(() => $`cat messages.json`.json()),
  roundTrip.via(({ message }) => $`test ${message} != Broken`),
  fuzz.via(({ target }) => $`cat crashes/${target}.json 2>/dev/null || echo '[]'`.json()),
]
const run = async (files: Record<string, string>, change: Record<string, string>, owed: unknown[]) => {
  const r = await repo({ "frames/benchmark.json": '{"p50":8,"p99":10,"hottest":["update"]}', "replays.txt": "state 1", "messages.json": "[]", ...files })
  await r.write(change)
  return (await Session.open({ cwd: r.root, project: project({ claims: [...owed, ...impls] } as never) as Project })).run()
}
const findings = (report: { claims: readonly Node[] }) => report.claims.map((n) => n.findings)

describe("game", () => {
  test("frame time must not regress by more than 5%", async () => {
    const slower = await run({}, { "frames/benchmark.json": '{"p50":9,"p99":12,"hottest":["pathfind"]}' }, [noFrameRegression])
    assert(findings(slower)).toEqual([["p99 frame time 10 → 12 ms; hottest: pathfind"]])
    const cold = await run({}, { "frames/benchmark.json": '{"p50":9,"p99":12,"hottest":[]}' }, [noFrameRegression])
    assert(findings(cold)).toEqual([["p99 frame time 10 → 12 ms; hottest: unknown"]])
    assert((await run({}, { "frames/benchmark.json": '{"p50":8,"p99":10.2,"hottest":[]}' }, [noFrameRegression])).ok).toBe(true)
  })

  test("replays are unchanged and deterministic", async () => {
    const changed = await run({}, { "replays.txt": "state 2" }, [replaysUnchanged, deterministic])
    assert(findings(changed)).toEqual([['replay differs at line 1: "state 1" → "state 2"'], ["replays diverged: h, h-last"]])
  })

  test("every changed message round-trips and survives fuzzing", async () => {
    const report = await run({}, { "messages.json": '["Spawn", "Broken", "Crashy"]', "crashes/Crashy.json": '[{"signature":"oob","input":"crash-1"}]' }, [safeMessages])
    // messages are checked concurrently, so only the set of calls is fixed, not their order
    const calls = report.claims[0]!.children.map((c) => `${c.title} ${Object.values(c.input as object).join(" ")} ${c.status}`)
    assert([...calls].sort()).toEqual([
      "Fuzz Crashy 30 passed",
      "Fuzz Spawn 30 passed",
      "Message round trip Broken failed",
      "Message round trip Crashy passed",
      "Message round trip Spawn passed",
      "Network messages  passed",
    ])
    assert(findings(report)).toEqual([["Crashy: oob (input crash-1)"]])
  })

  test("nothing changed in the part, nothing to prove", async () => {
    const r = await repo({ "replays.txt": "x" })
    const quiet = await (await Session.open({ cwd: r.root, project: project({ claims: [replaysUnchanged.in("sim"), ...impls] } as never) as Project })).run()
    assert([quiet.claims, quiet.idle]).toEqual([[], [{ title: "Replays are unchanged", reason: "nothing changed in sim" }]])
    assert(game.deps.map((d) => d.title)).toEqual(["Ship safely", "Simulation is deterministic", "Replays are unchanged", "No frame-time regression", "Every network message is safe"])
  })
})
