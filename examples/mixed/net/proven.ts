import { provide, sh } from "proven"
import { cargo } from "proven/kits"
import { networkMessage } from "proven/rules"
import { roundTrips, fuzzClean } from "proven/proofs"

export default provide(
  networkMessage.where(cargo.structsDeriving("NetMessage")),
  roundTrips.by(({ message }) => sh`cargo test -p net roundtrip_${message}`),
  fuzzClean.by(({ target, minutes }) =>
    sh`cargo fuzz run ${target} -- -max_total_time=${minutes * 60}`
      .artifacts(`fuzz/artifacts/${target}`)
      .findings(cargo.fuzzFindings),
  ),
)
