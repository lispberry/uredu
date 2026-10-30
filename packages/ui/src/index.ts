// UI: claims for screens people look at. Portable: no frameworks, browsers or paths. Projects provide
// which screens exist, how to screenshot one and how to audit its accessibility.
import { z } from "zod"
import { claim, git, all, fail, same, png } from "uredu"
import { shipSafely } from "@uredu/ship-safely"

const violation = z.object({ rule: z.string(), node: z.string(), impact: z.enum(["minor", "moderate", "serious", "critical"]) })

/** Screens worth checking, e.g. story ids or routes. */
export const screens = claim("Screens", {}, z.array(z.string()))
export const screenshot = claim("Screenshot", { screen: z.string() }, png)
export const a11y = claim("Accessibility audit", { screen: z.string() }, z.array(violation))

export const screensUnchanged = claim("Screens match base", async () => {
  if (!(await git.changed()).length) return
  await all(await screens(), async (screen) => same(await screenshot({ screen }), await screenshot.at(git.base)({ screen }), `screenshot of ${screen}`))
}, [screens, screenshot])

export const accessible = claim("Screens are accessible", async () => {
  if (!(await git.changed()).length) return
  const found = await all(await screens(), async (screen) => (await a11y({ screen })).map((v) => `${screen}: ${v.impact} ${v.rule} at ${v.node}`))
  if (found.flat().length) fail(found.flat())
}, [screens, a11y])

export const ui = claim("UI", [shipSafely, screensUnchanged, accessible])
