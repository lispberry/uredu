import { provide, sh } from "proven"
import { cargo } from "proven/kits"
import { simulation } from "proven/rules"
import { deterministic, output, bench } from "proven/proofs"

export default provide(
  simulation,
  deterministic.by(({ runs }) => sh`./tools/replay-hash.sh --runs ${runs}`),
  output.by(({ workload }) => sh`cargo run -p sim -- replay ${workload} --print-state`.value("stdout")),
  bench.by(({ target }) => sh`cargo bench --bench ${target} -- --output-format bencher`.samples(cargo.criterion)),
)
