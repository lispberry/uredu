# @uredu/game

Claims for a real-time multiplayer game. No engines, tools or paths.

| Claim | Kind | What it is |
|---|---|---|
| `frameTime` | abstract | `{ scene } → { p50, p99, hottest }`: frame-time statistics and the hottest stacks. |
| `replay` | abstract | `{ workload } → string`: simulation state after replaying a recorded workload. |
| `replayHashes` | abstract | `{ runs } → string[]`: final-state hashes over several runs of one replay. |
| `messages` | abstract | `→ string[]`: network message types the change touches. |
| `roundTrip` | abstract | `{ message }`: a message encodes and decodes losslessly. |
| `fuzz` | abstract | `{ target, minutes } → { signature, input }[]`: crashes found by fuzzing a decoder. |
| Simulation is deterministic | derived | Every replay run ends in the same state. |
| Replays are unchanged | derived | Replay output equals the merge-base with `main`. |
| No frame-time regression | derived | p99 frame time is at most 5% worse than at the merge-base with `main`. |
| Every network message is safe | derived | Each changed message round-trips, then survives 30 minutes of fuzzing. |
| `game` | group | Ship safely, plus all of the above. |
