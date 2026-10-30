# @uredu/ship-safely

The baseline every change owes. No languages, tools or paths.

| Claim | Kind | What it is |
|---|---|---|
| `build` | abstract | The code builds. |
| `tests` | abstract | `{ only?: string[] }`: the tests pass (only these files, when given). |
| `lint` | abstract | No lint findings. |
| `testInventory` | abstract | `→ { tests, skipped }`: how many tests exist and how many are skipped. |
| Code builds and tests pass | derived | When the part changed: `build`, `tests` and `lint` pass. |
| Tests are never skipped or deleted to go green | derived | When test files changed: no fewer tests and no more skipped ones than at base. |
| Bug fixes carry a regression test | derived | The change adds test files; on base, with only those files copied in, they fail; at head they pass. |
| `shipSafely` | group | The first two. |
| `regression` | group | The regression test, for fix steps in a workflow. |

`@uredu/ship-safely/kits` has `cargo` and `node`: ready-made `.via` lines for the four abstract claims.
