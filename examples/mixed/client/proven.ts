import { provide, sh } from "proven"
import { cargo } from "proven/kits"
import { client } from "proven/rules"
import { bench } from "proven/proofs"

export default provide(client, bench.by(({ target }) => sh`cargo bench -p client --bench ${target}`.samples(cargo.criterion)))
