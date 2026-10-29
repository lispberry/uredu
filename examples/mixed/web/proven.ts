// Override one kit default for the web app only.
import { provide, script, junit, code } from "proven"
import { testsPass } from "proven/proofs"

export default provide(code, testsPass.by(script("test:ci").report(junit("junit.xml"))))
