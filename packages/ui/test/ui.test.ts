import { describe, expect as assert, test } from "bun:test"
import { $, project, Session, type Project } from "uredu"
import { repo } from "../../uredu/test/helpers.ts"
import { a11y, accessible, screens, screenshot, screensUnchanged, ui } from "../src/index.ts"

// bytes, not a string: the repo helper writes whatever Bun.write accepts
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]) as unknown as string
const impls = [
  screens.via(() => $`ls shots`.text().then((t) => t.split("\n").map((f) => f.replace(".png", "")))),
  screenshot.via(({ screen }) => $`true`.file(`shots/${screen}.png`)),
  a11y.via(({ screen }) => $`cat audits/${screen}.json 2>/dev/null || echo '[]'`.json()),
]
const run = async (change: Record<string, string>) => {
  const r = await repo({ "shots/home.png": png(1), "shots/hud.png": png(2) })
  await r.write(change)
  return (await Session.open({ cwd: r.root, project: project({ claims: [screensUnchanged, accessible, ...impls] } as never) as Project })).run()
}

describe("ui", () => {
  test("screens match base", async () => {
    assert((await run({ "src/app.ts": "x" })).ok).toBe(true)
    const changed = await run({ "shots/hud.png": png(3) })
    assert(changed.claims[0]!.findings).toEqual(["screenshot of hud differs"])
  })

  test("screens are accessible", async () => {
    const report = await run({ "audits/hud.json": '[{"rule":"contrast","node":"#lock","impact":"serious"}]' })
    assert(report.claims[1]!.findings).toEqual(["hud: serious contrast at #lock"])
  })

  test("screenshots must be PNGs", async () => {
    const report = await run({ "shots/home.png": "not a png" })
    assert(report.claims[0]!.children.find((c) => c.findings.length)!.findings).toEqual(["value: not a PNG image"])
    assert(ui.deps.map((d) => d.title)).toEqual(["Ship safely", "Screens match base", "Screens are accessible"])
  })
})
