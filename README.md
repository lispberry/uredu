# proven

Done means proven. Proof-gated workflows for coding agents.

Rules say what must hold; they're portable and know nothing about languages or tools.
Proofs are typed interfaces; your project provides them. A rule that needs a proof no
provider covers is a compile error. Proven gates Claude Code (SessionStart, PostToolUse,
TaskCompleted, Stop hooks) and git commits with the same rules.

## Install

```sh
brew install lispberry/proven/proven
```

Then, in your repo:

```sh
proven init     # git pre-commit hook + Claude Code hooks
proven plan     # what the current change owes
proven run      # run it; exit 1 on failure
```

## A provenfile

```ts
// proven.ts
import { project, provide, sh, junit, code, tests } from "proven"
import { shipSafely } from "proven/rules"
import { builds, testsPass, newTests, noNewLint } from "proven/proofs"

const py = provide([code, tests.matching("tests/**")],
  builds.by(sh`uv run python -m compileall -q src`),
  testsPass.by(sh`uv run pytest --junitxml=junit.xml`.report(junit("junit.xml"))),
  newTests.by(sh`uv run pytest`),
  noNewLint.by(sh`uv run ruff check`),
)

export default project({ rules: [shipSafely], providers: [py.at(".")] })
```

The binary bundles the `proven` library, so a provenfile needs no `package.json` or
`node_modules`.

## Development

```sh
bun install
bun run test      # 100% line and function coverage is enforced
bun run build     # dist/proven
```

Releases: bump `version` in `packages/proven/package.json` and push to `main`.
