// Loaded before every test file (bunfig.toml). CI runners are slower than laptops.
import { setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)
