# uredu

Done means proven. A portable verification layer for coding agents and the people working with them.

You describe **what must be true** as claims: typed facts, written as plain async TypeScript. Your
project says **how** it proves the ones that need tools. Agents write workflows that list the claims each
step must meet, and a workflow that needs a claim your project can't provide **doesn't compile**. The
same claims gate Claude Code (hooks), git commits (pre-commit) and CI.

## Install

```sh
brew install lispberry/uredu/uredu
```

Then, in your repo:

```sh
uredu init     # git pre-commit hook + Claude Code hooks
uredu plan     # what the current change owes
uredu run      # prove it; exit 1 if anything fails
```

The binary bundles `uredu`, the shipped claim packages and `zod`, so a `uredu.ts` needs no
`package.json` or `node_modules`, in any language's repo.

In a Bun project you can install the libraries from npm instead, and get editor types for `uredu.ts`:

```sh
bun add -d uredu @uredu/ship-safely zod
```

## Claims

A claim is a fact as an async function, typed with [Zod](https://zod.dev). There are three kinds.

```ts
import { z } from "zod"
import { claim, git, fail, same } from "uredu"

const ms = z.number().positive()

// abstract: a name and a shape. Your project provides it.
export const frameTime = claim("Frame time", { scene: z.string() }, { p50: ms, p99: ms, hottest: z.array(z.string()) })
export const replay = claim("Replay output", { workload: z.string() }, z.string())

// derived: computed from other claims and git history. The dependency array comes last, like useEffect.
export const noFrameRegression = claim("No frame-time regression", async () => {
  const [now, before] = await Promise.all([frameTime({ scene: "benchmark" }), frameTime.at(git.mergeBase("main"))({ scene: "benchmark" })])
  if (now.p99 > before.p99 * 1.05) fail(`p99 ${before.p99} → ${now.p99} ms; hottest: ${now.hottest[0]}`)
}, [frameTime])

export const replaysUnchanged = claim("Replays are unchanged", async () => {
  same(await replay({ workload: "replays" }), await replay.at(git.mergeBase("main"))({ workload: "replays" }))
}, [replay])

// group: all of the listed claims.
export const game = claim("Game", [noFrameRegression, replaysUnchanged])
```

Inside a derived claim:

- `await p(input)` runs `p` and gives you its output, parsed by its schema.
- `p.at(rev)(input)` runs it at another revision (`git.base`, `git.mergeBase("main")`, `git.ref("v1.2")`). Each revision gets its own clean git worktree.
- `p.fails(input)` passes only if `p` fails.
- `fail(...)` fails the claim with findings. `same(a, b)` compares deeply. `faster(p, input, rev)` compares timings. `all(items, fn)` is `Promise.all` that reports every failure, not just the first.
- `git.changed(...globs)`, `git.added(...globs)` and `git.commits()` describe the change. `task.step` and `task.workflow` name the workflow step being verified.

A claim can only call what's in its dependency array, and the array is what the type checker uses.

Claim packages describe a domain and know nothing about your tools:

- **`@uredu/ship-safely`:**
  - abstract: `build`, `tests`, `lint`, `testInventory`;
  - derived: code builds and tests pass; tests are never skipped or deleted to go green; bug fixes carry a regression test that fails on base and passes at head;
  - groups: `shipSafely`, `regression`.
- **`@uredu/ui`:** screens match base, screens are accessible.
- **`@uredu/game`:** deterministic simulation, unchanged replays, no frame-time regression, every network message round-trips and survives fuzzing.

## Your project

`uredu.ts` at the repo root lists the claims the project owes, and says how it proves the abstract ones
with `.via`. This is the one Uredu itself uses:

```ts
import { project, claim, ready, $ } from "uredu"
import { build, lint, shipSafely, testInventory, tests } from "@uredu/ship-safely"

const typeTests = claim("Missing implementations don't compile")

const config = project({
  claims: [
    shipSafely,
    typeTests,
    ready.via(() => $`bun install --frozen-lockfile`), // once per fresh worktree
    build.via(() => $`bun run typecheck`),
    tests.via(({ only }) => (only?.length ? $`bun --config=bunfig.focused.toml test ${only}` : $`bun test`)),
    lint.via(() => $`bunx tsc --noEmit -p packages/uredu --noUnusedLocals --noUnusedParameters`),
    testInventory.via(() => $`bun test`.tests()),
    typeTests.via(() => $`bun run test:types`),
  ],
})

export default config

declare module "uredu" {
  interface Register {
    project: typeof config
  }
}
```

- **Entries without `.via`** are what the project owes. Any change owes them.
- **`.via`** implements an abstract claim, usually with `` $`…` ``. That's a Bun-style shell command, run by `sh` in a clean worktree at the right revision, with interpolated values quoted. It fails the claim when the command exits non-zero. Readers: `.text()`, `.json()`, `.file(path)`, `.junit(path)`, `.sarif(path)`, `.tests()` (test counts from bun, cargo, pytest, unittest, jest or vitest), `.samples()` (bencher timings), `.cwd(dir)`, `.nothrow()`.
- **Outputs are parsed** with the claim's Zod schema, so an implementation that returns junk fails.
- **The `declare module` lines** register the project's type, so workflows can be type-checked without importing it.

If an owed claim reaches an abstract claim with no `.via`, `uredu.ts` doesn't compile:

```text
uredu.ts:7:24 - error TS2345: … '{ readonly "claim 'Tests' (Ship safely → Code builds and tests pass) has no .via in the repo": never }'
```

### Kits

`@uredu/ship-safely/kits` has ready-made `.via` lines for the ship-safely claims: `cargo` and `node`.
Spread one into your list, and list your own line after it to override:

```ts
import { project, $ } from "uredu"
import { shipSafely, tests } from "@uredu/ship-safely"
import { node } from "@uredu/ship-safely/kits"

export default project({
  claims: [shipSafely, ...node, tests.via(() => $`npm run test:ci -- --reporter=junit`.junit("junit.xml"))],
})
```

### Parts of a repo

Most repos never need this. When parts of a repo use different tools or owe different claims, scope
entries with `.in(...)`:

```ts
import { project, $ } from "uredu"
import { frameTime, noFrameRegression } from "@uredu/game"
import { shipSafely } from "@uredu/ship-safely"
import { cargo, node } from "@uredu/ship-safely/kits"
import { a11y, screens, screenshot, ui } from "@uredu/ui"

export default project({
  claims: [
    shipSafely,
    ui.in("web"),
    noFrameRegression.in("sim"),
    ...node.in("web"),
    ...cargo.in("sim"),
    screens.via(() => $`npx storybook-list --json`.json()).in("web"),
    screenshot.via(({ screen }) => $`npx playwright screenshot --story ${screen} shot.png`.file("shot.png")).in("web"),
    a11y.via(({ screen }) => $`npx axe-story ${screen} --json`.json()).in("web"),
    frameTime.via(({ scene }) => $`../tools/tracy-capture ${scene} --json`.json()).in("sim"),
  ],
})
```

1. **Parts.** Each changed file belongs to the most specific path named in any `.in(...)`, otherwise to the repo root. A change to `web/src/Hud.tsx` belongs to `web`.
2. **What's owed.** `ui.in("web")` is owed when `web/` changes. An entry without `.in`, like `shipSafely`, is owed in every part the change touches.
3. **Where claims run.** A claim runs once per touched part:
   - its `git.changed()` sees only that part's files, relative to it;
   - every abstract call uses that part's `.via`, falling back to one without `.in`, and runs in that part's directory.
   
   So the same `shipSafely` runs `npm test` in `web/` and `cargo test` in `sim/`.
4. **The type check follows the same rule.** `noFrameRegression.in("sim")` needs `frameTime` provided in `sim/`, or without `.in`.

`examples/mixed` is a fuller version, with a workflow.

## Workflows

An agent writes a workflow for a task. Each step lists the claims it must meet, and the workflow's own
list applies to every step:

```ts
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
```

If the project doesn't provide something a step needs, the workflow doesn't compile:

```text
workflows/homing-missiles.ts:10:20 - error TS2345: Argument of type '"HUD shows lock-on"' is not assignable to
  parameter of type '"claim 'Accessibility audit' (UI → Screens are accessible) is not provided in uredu.ts"'.
```

The agent can't route around a missing standard. Either the project gains the implementation (a person
adds the `.via` line, since agents can't edit `uredu.ts`) or the step doesn't exist. That's how a project
gets brought up to a standard gradually.

To plan or verify one step:

```sh
uredu plan --workflow workflows/homing-missiles.ts --step hud-shows-lock-on
```

```sh
uredu run --workflow workflows/homing-missiles.ts --step hud-shows-lock-on
```

## How runs work

- **Clean worktrees.** Every abstract claim runs in a git worktree under `.git/uredu/` at the revision it was asked for. The working tree is snapshotted into a commit first, so edits made during a run never leak in. `ready` runs once per fresh worktree.
- **Caching.** Outputs are cached by claim, input, implementation source, part, revision and output schema, so unchanged work isn't rerun. Use `--no-cache` to rerun everything. Timing comparisons are never cached.
- **Bisecting.** When a claim fails and the change spans several commits, `uredu run` bisects it and names the first failing commit. Use `--no-bisect` to skip that.
- **Run records.** Each run keeps its log and a `run.json` in `.git/uredu/runs/<id>/`.

## Hooks

`uredu init` installs:

- a **git pre-commit hook** that proves what's staged;
- **Claude Code hooks:**
  - `SessionStart` tells the agent what's owed;
  - `PostToolUse` updates that after edits;
  - `TaskCompleted` and `Stop` block until everything is proven; after 5 blocked stops the agent may stop and hand over to a person;
- **deny rules** so agents can't edit any `uredu.ts`.

## Development

```sh
bun install
```

```sh
bun run test
```

```sh
bun run build
```

`bun run test` enforces 100% line and function coverage and runs the type-level tests. `bun run build`
writes `dist/uredu`. This repo is gated by its own `uredu.ts`, both in hooks and in CI. To release, bump
`version` in all four `packages/*/package.json` (uredu, ship-safely, game, ui) and push to `main`. That
publishes the binaries, the Homebrew formula and, when an `NPM_TOKEN` secret is set, the npm packages.
