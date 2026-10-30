// Kits: ready-made .via lines for the ship-safely claims, one per toolchain. Spread one into a project's
// claims (`...cargo`), scope it (`...cargo.in("sim")`), and override any line by listing your own after it.
import { kit, $ } from "uredu"
import { build, lint, testInventory, tests } from "./index.ts"

export const cargo = kit(
  build.via(() => $`cargo build --all-targets`),
  tests.via(({ only }) => (only?.length ? $`cargo test --test ${only.map((f) => f.replace(/^.*\//, "").replace(/\.rs$/, ""))}` : $`cargo test`)),
  lint.via(() => $`cargo clippy --all-targets -- -D warnings`),
  testInventory.via(() => $`cargo test`.tests()),
)

export const node = kit(
  build.via(() => $`npm run build --if-present`),
  tests.via(({ only }) => $`npm test -- ${only ?? []}`),
  lint.via(() => $`npm run lint --if-present`),
  testInventory.via(() => $`npm test`.tests()),
)
