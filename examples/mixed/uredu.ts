// A game with a Rust simulation and client, and a web dashboard. One flat list: what the project owes, and
// how it proves the abstract claims. `.in(...)` only where parts of the repo differ.
import { project, $ } from "uredu"
import { frameTime, fuzz, game, messages, replay, replayHashes, roundTrip } from "@uredu/game"
import { shipSafely } from "@uredu/ship-safely"
import { cargo, node } from "@uredu/ship-safely/kits"
import { a11y, screens, screenshot, ui } from "@uredu/ui"

const config = project({
  claims: [
    shipSafely,
    game.in("sim", "client"),
    ui.in("web"),

    ...cargo.in("sim", "client"),
    ...node.in("web"),

    frameTime.via(({ scene }) => $`../tools/tracy-capture ${scene} --json`.json()).in("sim", "client"),
    replay.via(({ workload }) => $`cargo run -q -p sim -- replay ${workload} --print-state`.text()).in("sim", "client"),
    replayHashes.via(({ runs }) => $`../tools/replay-hash.sh --runs ${runs}`.json()).in("sim", "client"),
    messages.via(() => $`cargo run -q -p net --bin list-messages -- --changed`.json()).in("sim", "client"),
    roundTrip.via(({ message }) => $`cargo test -q -p net roundtrip_${message}`).in("sim", "client"),
    fuzz.via(({ target, minutes }) => $`./tools/fuzz.sh ${target} ${minutes * 60}`.json()).in("sim", "client"),

    screens.via(() => $`npx storybook-list --json`.json()).in("web"),
    screenshot.via(({ screen }) => $`npx playwright screenshot --story ${screen} shot.png`.file("shot.png")).in("web"),
    a11y.via(({ screen }) => $`npx axe-story ${screen} --json`.json()).in("web"),
  ],
})

export default config

declare module "uredu" {
  interface Register {
    project: typeof config
  }
}
