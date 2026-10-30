import { describe, expect as assert, test } from "bun:test"
import { $, format, project, Session, type Node, type Project } from "uredu"
import { repo, tmp } from "../../uredu/test/helpers.ts"
import { build, lint, regression, shipSafely, testInventory, tests } from "../src/index.ts"
import { cargo, node } from "../src/kits.ts"

// tests are shell scripts in tests/; each passes or fails on its own
const runTests = ({ only }: { only?: string[] }) => $`for t in ${only ?? []} $(test -n "${(only ?? []).join(" ")}" || ls tests/*.sh); do sh "$t" || exit 1; done`
const claims = [
  shipSafely,
  build.via(() => $`test ! -f broken`),
  tests.via(runTests),
  lint.via(() => $`! grep -rq TODO src`),
  testInventory.via(async () => ({ tests: Number(await $`ls tests | wc -l`.text()), skipped: Number(await $`cat tests/*.sh | grep -c skip || true`.text()) })),
]
const p = project({ claims }) as Project
const find = (n: Node, title: string): Node => (n.title === title ? n : n.children.map((c) => find(c, title)).find(Boolean)!)

describe("ship safely", () => {
  test("code builds, tests pass, lint is clean", async () => {
    const r = await repo({ "src/a.txt": "ok", "tests/a.sh": "true", "tests/b.sh": "true" })
    await r.write({ "src/a.txt": "TODO" })
    const report = await (await Session.open({ cwd: r.root, project: p })).run()
    const root = report.claims[0]!
    assert(find(root, "Code builds and tests pass").children.map((c) => [c.title, c.status])).toEqual([
      ["Build", "passed"],
      ["Tests", "passed"],
      ["Lint", "failed"],
    ])
    assert(find(root, "Tests are never skipped or deleted to go green").children).toEqual([]) // no test changed
  })

  test("deleting or skipping tests to go green fails", async () => {
    const r = await repo({ "tests/a.sh": "true", "tests/b.sh": "true" })
    await r.remove("tests/b.sh")
    const deleted = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(find(deleted.claims[0]!, "Tests are never skipped or deleted to go green").findings).toEqual(["tests went from 2 to 1"])

    await r.write({ "tests/b.sh": "true # skip" })
    const skipped = await (await Session.open({ cwd: r.root, project: p })).run()
    assert(find(skipped.claims[0]!, "Tests are never skipped or deleted to go green").findings).toEqual(["skipped tests went from 0 to 1"])
  })

  test("a fix needs a test that fails before it and passes after", async () => {
    const r = await repo({ "src/v.txt": "bad", "tests/a.sh": "true" })
    const fixes = project({ claims: [regression, ...claims.slice(1)] }) as Project
    await r.write({ "src/v.txt": "good" })
    const untested = await (await Session.open({ cwd: r.root, project: fixes })).run()
    assert(find(untested.claims[0]!, "Bug fixes carry a regression test").findings).toEqual(["a fix needs a new test that fails before the fix and passes after it"])

    await r.write({ "tests/v.sh": "grep -q good src/v.txt" })
    const tested = await (await Session.open({ cwd: r.root, project: fixes })).run()
    assert(tested.ok).toBe(true)
    assert(format(tested)).toContain("✓ Regression")
  })
})

describe("kits", () => {
  const command = (v: { impl: (input: never) => unknown }, input: object = {}) => ((v.impl as (i: object) => { command: string })(input)).command
  test("cargo", () => {
    assert(cargo.map((v) => v.claim)).toEqual([build, tests, lint, testInventory])
    assert(cargo.slice(0, 3).map((v) => command(v))).toEqual(["cargo build --all-targets", "cargo test", "cargo clippy --all-targets -- -D warnings"])
    assert(command(cargo[1]!, { only: ["tests/net/round_trip.rs"] })).toBe("cargo test --test round_trip")
    assert(cargo.in("sim").map((v) => v.paths)).toEqual([["sim"], ["sim"], ["sim"], ["sim"]])
  })

  test("node", () => {
    assert(node.slice(0, 3).map((v) => command(v))).toEqual(["npm run build --if-present", "npm test --", "npm run lint --if-present"])
    assert(command(node[1]!, { only: ["a.test.ts"] })).toBe("npm test -- a.test.ts")
  })

  test("test inventories read the runner's summary", async () => {
    // an empty directory: neither runner finds a project, so neither prints a summary
    const here = process.cwd()
    process.chdir(await tmp())
    try {
      for (const k of [cargo, node]) await assert((k[3]!.impl as () => Promise<unknown>)()).rejects.toThrow("no test summary in its output")
    } finally {
      process.chdir(here)
    }
  })
})
