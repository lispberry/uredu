import { project } from "proven"
import { cargo, node } from "proven/kits"
import { shipSafely, lockstep } from "proven/rules"
import sim from "./sim/proven.ts"
import net from "./net/proven.ts"
import client from "./client/proven.ts"
import web from "./web/proven.ts"

export default project({
  rules: [shipSafely, lockstep],
  providers: [
    cargo.at("sim", "net", "client"),
    node.at("web"),
    sim.at("sim"),
    net.at("net"),
    client.at("client"),
    web.at("web"),
  ],
})
