// Compile-time guarantees. Every @ts-expect-error must stay an error; `bun run test:types` fails if one stops erroring.
import { project, provide, sh, workflow, rule, git, area, type Req } from "proven"
import { cargo } from "proven/kits"
import { shipSafely, lockstep, deterministicSim, simulation, client, networkMessage } from "proven/rules"
import { deterministic, output, bench, roundTrips, fuzzClean, prLinksIssue, testsPass } from "proven/proofs"

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>() => {}

// ── a rule's type carries what it requires ────────────────────────────────────
type ReqsOf<R> = R extends { readonly __reqs?: infer X } ? X : never
assertType<Equals<ReqsOf<typeof deterministicSim>, Req<"simulation", "deterministic", "Simulation is deterministic">>>()
type LockstepPairs = ReqsOf<typeof lockstep> extends infer R ? (R extends Req<infer A, infer P> ? `${A}::${P}` : never) : never
assertType<
  Equals<
    LockstepPairs,
    | "simulation::deterministic"
    | "simulation::output"
    | "network message::roundTrips"
    | "network message::fuzzClean"
    | "simulation::bench"
    | "client::bench"
  >
>()

// ── providers ────────────────────────────────────────────────────────────────
const sim = provide(
  simulation,
  deterministic.by(({ runs }) => sh`./tools/replay-hash.sh --runs ${runs}`),
  output.by(({ workload }) => sh`cargo run -p sim -- replay ${workload}`.value("stdout")),
  bench.by(({ target }) => sh`cargo bench --bench ${target}`.samples(cargo.criterion)),
)
const net = provide(
  networkMessage.where(cargo.structsDeriving("NetMessage")),
  roundTrips.by(({ message }) => sh`cargo test -p net roundtrip_${message}`),
  fuzzClean.by(({ target, minutes }) => sh`cargo fuzz run ${target} -- -max_total_time=${minutes * 60}`),
)
const cli = provide(client, bench.by(({ target }) => sh`cargo bench -p client --bench ${target}`))

// a prover gets its proof's argument types
// @ts-expect-error — `runs` is a number, `.toUpperCase` does not exist
provide(simulation, deterministic.by(({ runs }) => sh`${runs.toUpperCase()}`))
// @ts-expect-error — testsPass takes no arguments, so its prover is an instrument, not a function
provide(simulation, testsPass.by(() => sh`cargo test`))

// ── complete project compiles ────────────────────────────────────────────────
const proj = project({
  rules: [shipSafely, lockstep],
  providers: [cargo.at("sim", "net", "client"), sim.at("sim"), net.at("net"), cli.at("client")],
})

// ── missing prover: bench for simulation ─────────────────────────────────────
const simNoBench = provide(
  simulation,
  deterministic.by(({ runs }) => sh`./tools/replay-hash.sh --runs ${runs}`),
  output.by(({ workload }) => sh`cargo run -p sim -- replay ${workload}`),
)
// @ts-expect-error — proof 'bench' is missing for area 'simulation' (required by "No frame-time regression")
project({
  rules: [shipSafely, lockstep],
  providers: [cargo.at("sim", "net", "client"), simNoBench.at("sim"), net.at("net"), cli.at("client")],
})

// ── missing area: nothing provides "network message" ─────────────────────────
// @ts-expect-error — area 'network message' has no provider
project({
  rules: [lockstep],
  providers: [sim.at("sim"), cli.at("client")],
})

// ── area-less requirement (task.is("fix")) needs some provider of newTests ───
// @ts-expect-error — proof 'newTests' has no provider (required by "Bug fixes carry a regression test")
project({
  rules: [shipSafely],
  providers: [provide([area("code"), area("tests")], testsPass.by(sh`x`)).at(".")],
})

// ── a provider must be placed with .at() ─────────────────────────────────────
project({
  rules: [lockstep],
  // @ts-expect-error — sim is not located
  providers: [sim, net.at("net"), cli.at("client")],
})

// ── rule bodies: expect is limited to `uses`, and typed by each proof ───────
rule("Uses only what it declares", { when: git.changed(simulation), uses: { deterministic } }, ({ expect }) => {
  expect(deterministic, { runs: 10 }).toPass()
  // @ts-expect-error — bench is not in uses
  expect(bench, { target: "frame" }).toPass()
  // @ts-expect-error — wrong argument shape
  expect(deterministic, { run: 10 }).toPass()
  // @ts-expect-error — fuzzClean-style args are required, not optional
  expect(deterministic).toPass()
})

// declared proofs are also on the context, Playwright-style
rule("Destructured proofs", { uses: { deterministic } }, ({ expect, deterministic: d }) => {
  expect(d, { runs: 1 }).toPass()
})

// async bodies: awaiting an expectation yields its verdict
rule("Async", { each: git.diff(git.base, git.head).symbols(networkMessage), uses: { roundTrips } }, async ({ expect }, msg) => {
  const verdict = await expect(roundTrips, { message: msg }).toPass()
  const ok: boolean = verdict.ok
  // @ts-expect-error — msg is a string
  msg.toFixed()
  return void ok
})

// a rule's requirements come from `uses`, not from what the body happens to call
type R2 = ReqsOf<ReturnType<typeof rule<"r", { deterministic: typeof deterministic }, [], "simulation">>>
assertType<Equals<R2, Req<"simulation", "deterministic", "r">>>()

// ── workflows: typed skips, expectations limited to what the project proves ──
workflow(proj, "Homing missiles", ({ step, expect }) => {
  const hud = step("Player sees lock-on", { skip: [{ rule: deterministicSim, why: "Presentation only" }] })
  // @ts-expect-error — prLinksIssue has no provider in this project
  step("PR is linked", { after: [hud], done: [expect(prLinksIssue).toPass()] })
  // @ts-expect-error — not a rule
  step("bad skip", { skip: [{ rule: simulation, why: "nope" }] })
})
