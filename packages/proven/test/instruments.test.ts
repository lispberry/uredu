import { describe, expect as assert, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { builtin, hook, http, junit, parser, preCommit, sarif, script, sh } from "proven"
import { describe as describeInstrument, execute } from "../src/engine/instruments.ts"
import { findingsWith, junitFindings, samplesWith, sarifFindings } from "../src/engine/parsers.ts"
import { compare, normalCdf } from "../src/engine/stats.ts"
import { tmp } from "./helpers.ts"

describe("parsers", () => {
  test("bencher samples", () => {
    const out = "test a ... bench:       1,234 ns/iter (+/- 5)\ntest b ... bench: 10.5 ns/iter (+/- 1)\n"
    assert(samplesWith("bencher", out)).toEqual([1234, 10.5])
    assert(samplesWith("criterion", out)).toEqual([1234, 10.5])
    assert(() => samplesWith("nope", out)).toThrow("unknown samples parser: nope")
  })
  test("cargo fuzz crashes", () => {
    const panic = "thread '<unnamed>' panicked at net/src/missile.rs:88:17:\nindex out of bounds\n...\nTest unit written to ./fuzz/artifacts/spawn/crash-91ab\n"
    assert(findingsWith("cargo-fuzz", panic)).toEqual([
      { message: "index out of bounds", location: { file: "net/src/missile.rs", line: 88 }, reproducer: "./fuzz/artifacts/spawn/crash-91ab", severity: "error" },
    ])
    assert(findingsWith("cargo-fuzz", "==12== ERROR: libFuzzer: deadly signal\n")).toEqual([
      { message: "deadly signal", location: undefined, reproducer: undefined, severity: "error" },
    ])
    assert(findingsWith("cargo-fuzz", "Done 1000 runs")).toEqual([])
    assert(() => findingsWith("nope", "")).toThrow("unknown findings parser: nope")
  })
  test("junit", () => {
    const xml = `<testsuite>
      <testcase classname="sim" name="ok"/>
      <testcase classname="sim" name="bad" file="sim/a.rs"><failure message="boom">trace</failure></testcase>
      <testcase name="err"><error type="E"/></testcase>
      <testcase name="passing-with-body"><system-out>hi</system-out></testcase>
    </testsuite>`
    assert(junitFindings(xml)).toEqual([
      { message: "sim › bad: boom", location: { file: "sim/a.rs" }, severity: "error" },
      { message: "err: error", location: undefined, severity: "error" },
    ])
  })
  test("sarif", () => {
    const log = {
      runs: [
        {
          results: [
            { level: "warning", message: { text: "w" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 3 } } }] },
            { level: "note", message: { text: "n" } },
            { level: "error" },
          ],
        },
        {},
      ],
    }
    assert(sarifFindings(JSON.stringify(log))).toEqual([
      { message: "w", location: { file: "a.ts", line: 3 }, severity: "warning" },
      { message: "n", location: undefined, severity: "note" },
      { message: "(no message)", location: undefined, severity: "error" },
    ])
    assert(sarifFindings("{}")).toEqual([])
  })
})

describe("stats", () => {
  test("normal cdf", () => {
    assert(normalCdf(0)).toBeCloseTo(0.5, 6)
    assert(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    assert(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })
  test("compare", () => {
    assert(compare([10, 11, 10, 11], [5, 6, 5, 6]).confidence).toBeGreaterThan(0.99)
    assert(compare([5, 5], [10, 10]).confidence).toBe(0)
    assert(compare([5], [3]).confidence).toBe(1)
    assert(compare([5], [5]).confidence).toBe(0.5)
    assert(() => compare([], [1])).toThrow("need samples")
  })
})

describe("execute", async () => {
  const signal = new AbortController().signal
  const run = async (i: Parameters<typeof execute>[0], files: Record<string, string> = {}, env?: Record<string, string>) => {
    const cwd = await tmp()
    for (const [p, c] of Object.entries(files)) {
      await mkdir(join(cwd, p, ".."), { recursive: true })
      await Bun.write(join(cwd, p), c)
    }
    return { verdict: await execute(i, { cwd, runDir: join(cwd, ".run"), signal, env }), cwd }
  }

  test("sh: exit code, log, value, samples", async () => {
    const { verdict, cwd } = await run(sh`echo '  hello  '`.value("stdout"))
    assert(verdict).toEqual({ ok: true, value: "hello", samples: undefined, findings: [], artifacts: [] })
    assert(await Bun.file(join(cwd, ".run", "log")).text()).toBe("$ echo '  hello  '\n  hello  \n")
    assert((await run(sh`echo 'bench: 7 ns/iter'`.samples(parser("bencher")))).verdict.samples).toEqual([7])
    assert((await run(sh`cat out.json`.value({ file: "out.json" }), { "out.json": "{}" })).verdict.value).toBe("{}")
    assert((await run(sh`echo $GREETING`.value("stdout"), {}, { GREETING: "hi" })).verdict.value).toBe("hi")
  })
  test("failures carry the last stderr line", async () => {
    assert((await run(sh`echo nope >&2; exit 4`)).verdict.findings).toEqual([{ message: "echo nope >&2; exit 4 exited with 4: nope", severity: "error" }])
    assert((await run(sh`exit 1`)).verdict.findings).toEqual([{ message: "exit 1 exited with 1", severity: "error" }])
  })
  test("scripts from package.json, Makefile, justfile", async () => {
    assert((await run(script("hi"), { "package.json": JSON.stringify({ scripts: { hi: "echo pkg" } }) })).verdict.ok).toBe(true)
    assert((await run(script("hi"), { "package.json": "{}", Makefile: "hi:\n\t@echo make\n" })).verdict.ok).toBe(true)
    const just = await run(script("hi"), { justfile: "hi:\n  echo just\n" })
    assert(just.verdict.ok || just.verdict.findings[0]!.message.includes("just")).toBe(true) // `just` may not be installed
    assert((await run(script("hi"))).verdict.findings[0]!.message).toStartWith('no script "hi"')
  })
  test("hooks, pre-commit, builtins", async () => {
    const dir = await tmp()
    await Bun.write(join(dir, "pre-commit"), "#!/bin/sh\necho \"pre-commit $@\"\n")
    await chmod(join(dir, "pre-commit"), 0o755)
    const pc = await run(preCommit("ruff").value("stdout"), {}, { PATH: `${dir}:${process.env.PATH}` })
    assert(pc.verdict.value).toBe("pre-commit run ruff --all-files")
    const cwd = await tmp()
    await Bun.write(join(cwd, "check.sh"), "#!/bin/sh\nexit 0\n")
    await chmod(join(cwd, "check.sh"), 0o755)
    assert((await execute(hook("check.sh"), { cwd, runDir: join(cwd, ".run"), signal })).ok).toBe(true)
    assert((await run(builtin("magic"))).verdict.findings[0]!.message).toBe('builtin "magic" is not implemented yet')
  })
  test("http", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/ok" ? new Response("up") : new Response("down", { status: 503 })) })
    try {
      assert((await run(http.get(`http://localhost:${server.port}/ok`).value("stdout"))).verdict).toMatchObject({ ok: true, value: "up" })
      assert((await run(http.get(`http://localhost:${server.port}/x`))).verdict.findings[0]!.message).toContain("HTTP 503")
    } finally {
      server.stop(true)
    }
    assert((await run(http.get("http://127.0.0.1:1/never"))).verdict.findings[0]!.message).toStartWith("GET http://127.0.0.1:1/never failed")
  })
  test("reports, findings parsers, artifacts", async () => {
    const xml = '<testsuite><testcase name="t"><failure message="m"/></testcase></testsuite>'
    assert((await run(sh`true`.report(junit("r.xml")), { "r.xml": xml })).verdict).toMatchObject({ ok: false, findings: [{ message: "t: m" }] })
    const warn = JSON.stringify({ runs: [{ results: [{ level: "warning", message: { text: "w" } }] }] })
    assert((await run(sh`true`.report(sarif("r.sarif")), { "r.sarif": warn })).verdict).toMatchObject({ ok: true, findings: [{ severity: "warning" }] })
    assert((await run(sh`true`.report(junit("missing.xml")))).verdict.findings[0]!.message).toBe("report missing.xml was not written")
    assert((await run(sh`echo 'ERROR: libFuzzer: crash'`.findings(parser("cargo-fuzz")))).verdict.ok).toBe(false)
    const art = await run(sh`true`.artifacts("crash", "dir", "absent"), { crash: "bytes", "dir/inner": "x" })
    assert(art.verdict.artifacts).toEqual([join(art.cwd, ".run", "artifacts", "crash"), join(art.cwd, ".run", "artifacts", "dir")])
    assert(await Bun.file(join(art.cwd, ".run", "artifacts", "dir", "inner")).text()).toBe("x")
  })
  test("descriptions", () => {
    assert([sh`a`, script("b"), http.get("c"), hook("d"), preCommit("e"), builtin("f")].map(describeInstrument)).toEqual([
      "a",
      "script b",
      "GET c",
      "d",
      "pre-commit e",
      "builtin f",
    ])
  })
})
