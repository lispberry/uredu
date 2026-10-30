# @uredu/ui

Claims for screens people look at. No frameworks, browsers or paths.

| Claim | Kind | What it is |
|---|---|---|
| `screens` | abstract | `→ string[]`: screens worth checking, e.g. story ids or routes. |
| `screenshot` | abstract | `{ screen } → png`: a screenshot (PNG bytes, checked). |
| `a11y` | abstract | `{ screen } → { rule, node, impact }[]`: accessibility violations. |
| Screens match base | derived | Every screen looks exactly as it did at base. |
| Screens are accessible | derived | No screen has accessibility violations. |
| `ui` | group | Ship safely, plus both of the above. |
