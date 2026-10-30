# uredu

Done means proven. Typed claims, written as plain async TypeScript, that gate coding agents (Claude Code
hooks), git commits (pre-commit) and CI.

```ts
import { project, $ } from "uredu"
import { shipSafely, build, tests, lint, testInventory } from "@uredu/ship-safely"

export default project({
  claims: [
    shipSafely,
    build.via(() => $`cargo build --all-targets`),
    tests.via(() => $`cargo test`),
    lint.via(() => $`cargo clippy -- -D warnings`),
    testInventory.via(() => $`cargo test`.tests()),
  ],
})
```

Needs [Bun](https://bun.sh) 1.4.4 or later. Most repos use the standalone binary instead, which needs
neither Bun nor `node_modules`:

```sh
brew install lispberry/uredu/uredu
```

See the [full documentation](https://github.com/lispberry/uredu#readme).
