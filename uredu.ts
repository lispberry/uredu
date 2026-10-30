// Uredu gates its own repository with the claims it ships.
import { project, claim, ready, $ } from "uredu"
import { build, lint, shipSafely, testInventory, tests } from "@uredu/ship-safely"

const typeTests = claim("Missing implementations don't compile")

const config = project({
  claims: [
    shipSafely,
    typeTests,
    ready.via(() => $`bun install --frozen-lockfile`),
    build.via(() => $`bun run typecheck`),
    // the whole suite enforces 100% coverage (bunfig.toml); a focused run of a few files can't
    tests.via(({ only }) =>
      only?.length ? $`bun --config=bunfig.focused.toml test ${only}` : $`bun test --reporter=junit --reporter-outfile=junit.xml`.junit("junit.xml"),
    ),
    lint.via(() => $`bunx tsc --noEmit -p packages/uredu --noUnusedLocals --noUnusedParameters`),
    testInventory.via(() => $`bun test`.tests()), // counts are read whether or not the run passes
    typeTests.via(() => $`bun run test:types`),
  ],
})

export default config

declare module "uredu" {
  interface Register {
    project: typeof config
  }
}
