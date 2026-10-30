import { describe, expect as assert, test } from "bun:test"
import { z } from "zod"
import { $, fail, git, kit, png, project, claim, ClaimFailure, ready, same, task, workflow } from "uredu"
import { junitFindings, samples, sarifFindings, testCounts } from "../src/engine/parsers.ts"
import { compare, normalCdf } from "../src/engine/stats.ts"
import { tmp } from "./helpers.ts"

const frameTime = claim("Frame time", { scene: z.string() }, { p99: z.number() })
const build = claim("Build")
const noRegression = claim("No regression", async () => {
  await frameTime({ scene: "x" })
}, [frameTime])
const game = claim("Game", [build, noRegression])

describe("claims", () => {
  test("abstract claims carry their schemas", () => {
    assert([frameTime.type, build.type, ready.type]).toEqual(["abstract", "abstract", "abstract"])
    assert(frameTime.title).toBe("Frame time")
    assert(frameTime.input!.parse({ scene: "s" })).toEqual({ scene: "s" })
    assert(frameTime.output!.parse({ p99: 1 })).toEqual({ p99: 1 })
    assert(claim("Text", {}, z.string()).output!.parse("x")).toBe("x")
    assert([build.input, build.output]).toEqual([undefined, undefined])
  })

  test("derived claims list their deps", () => {
    assert(noRegression.type).toBe("derived")
    assert(noRegression.deps).toEqual([frameTime])
  })

  test("groups list their members", () => {
    assert(game.type).toBe("group")
    assert(game.deps).toEqual([build, noRegression])
  })

  test("deps must be claims", () => {
    assert(() => claim("Bad", [1 as never])).toThrow('claim "Bad": deps must be claims')
  })
})

describe("implementations", () => {
  test("via covers the whole repo, in scopes it", () => {
    const v = build.via(() => $`true`)
    assert([v.kind, v.claim, v.paths]).toEqual(["via", build, ["*"]])
    assert(v.in("web", "api").paths).toEqual(["web", "api"])
  })

  test("in on an owed claim scopes what's owed", () => {
    assert(game.in("sim")).toEqual({ kind: "owed", claim: game, paths: ["sim"] })
  })

  test("only abstract claims take via", () => {
    assert(() => game.via(() => undefined as never)).toThrow('"Game" is group; only abstract claims take .via')
  })

  test("kits scope every line", () => {
    const k = kit(build.via(() => $`true`), frameTime.via(async () => ({ p99: 1 })))
    assert(k).toHaveLength(2)
    assert(k.in("sim").map((x) => x.paths)).toEqual([["sim"], ["sim"]])
  })

  test("calls only run inside uredu", async () => {
    assert(() => build()).toThrow("claims run inside uredu")
    await assert(git.changed()).rejects.toThrow("claims run inside uredu")
    assert(() => task.step).toThrow("claims run inside uredu")
  })
})

describe("project", () => {
  test("env defaults to empty", () => {
    const p = project({ claims: [game, build.via(() => $`true`), frameTime.via(async () => ({ p99: 1 })).in("sim")] })
    assert(p.env).toEqual({})
    assert(project({ claims: [], env: { A: "1" } }).env).toEqual({ A: "1" })
  })

  test("rejects entries that aren't claims", () => {
    assert(() => project({ claims: [{} as never] })).toThrow("project: claims must be claims")
  })
})

describe("workflows", () => {
  // no project is registered in this package, so titles can't be checked against one here
  test("steps get ids, order and outputs", () => {
    const flow = workflow("Ship it" as never, [build], ({ step }) => {
      const a = step("Design it" as never, [], { produces: ["docs/x.md"] })
      step("Build it!" as never, [game], { after: [a] })
    })
    assert(flow.steps.map((s) => [s.id, s.claims.length, s.after.map((x) => x.id), s.produces])).toEqual([
      ["design-it", 0, [], ["docs/x.md"]],
      ["build-it", 1, ["design-it"], []],
    ])
    assert(flow.claims).toEqual([build])
  })

  test("step ids must be unique", () => {
    assert(() => workflow("Twice" as never, [], ({ step }) => (step("A" as never, []), step("a" as never, [])))).toThrow('workflow "Twice": duplicate step "a"')
  })
})

describe("helpers", () => {
  test("fail collects findings", () => {
    const findings = (f: () => void) => {
      try {
        f()
      } catch (e) {
        return (e as ClaimFailure).findings
      }
    }
    assert(findings(() => fail("one", ["two", { message: "three" }, { x: 1 }], new Error("four")))).toEqual(["one", "two", "three", '{"x":1}', "four"])
  })

  test("same passes on deep equality", () => {
    same({ a: [1] }, { a: [1] })
  })

  test("same points at the first differing line", () => {
    assert(() => same("a\nb\nc", "a\nB\nc", "replay")).toThrow('replay differs at line 2: "B" → "b"')
  })

  test("same notices a missing line", () => {
    assert(() => same("a\nb", "a")).toThrow('output differs at line 2: "" → "b"')
  })

  test("same compares bytes", () => {
    assert(() => same(new Uint8Array([1]), new Uint8Array([2]))).toThrow("output differs")
  })

  test("png accepts the PNG signature", () => {
    assert(png.safeParse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).success).toBe(true)
  })

  test("png rejects other bytes", () => {
    assert(png.safeParse(new Uint8Array([1, 2])).success).toBe(false)
  })
})

describe("$", () => {
  test("quotes values and expands arrays", async () => {
    const dir = await tmp()
    const cmd = $`echo ${["a b", "c"]} ${"x"}`.cwd(dir)
    assert(cmd.command).toBe("echo a b c x")
    assert(await cmd.text()).toBe("a b c x")
    await cmd
  })

  test("reads json", async () => {
    assert(await $`echo '{"n":1}'`.json()).toEqual({ n: 1 })
  })

  test("nothrow returns the exit code", async () => {
    assert(await $`exit 3`.nothrow()).toEqual({ code: 3, stdout: "", stderr: "" })
  })

  test("fails with the last line of stderr, else stdout", async () => {
    await assert($`echo out; echo bad >&2; exit 2`.text()).rejects.toThrow("echo out; echo bad >&2; exit 2 exited with 2: bad")
    await assert(Promise.resolve($`exit 1`)).rejects.toThrow("exit 1 exited with 1")
    await assert(Promise.resolve($`echo only-stdout; exit 1`)).rejects.toThrow("exited with 1: only-stdout")
  })

  test("cwd nests and file reads bytes", async () => {
    const dir = await tmp()
    await Bun.write(`${dir}/sub/f.bin`, new Uint8Array([7, 8]))
    assert(await $`true`.cwd(dir).cwd("sub").file("f.bin")).toEqual(new Uint8Array([7, 8]))
  })

  test("junit fails on failed test cases", async () => {
    const dir = await tmp()
    const junit = `<testsuite><testcase classname="A" name="ok"/><testcase classname="A" name="bad" file="a.ts"><failure message="boom"/></testcase></testsuite>`
    await Bun.write(`${dir}/pass.xml`, "<testsuite><testcase name='x'/></testsuite>")
    await Bun.write(`${dir}/fail.xml`, junit)
    await $`true`.cwd(dir).junit("pass.xml")
    await assert($`true`.cwd(dir).junit("fail.xml")).rejects.toThrow("A › bad: boom (a.ts)")
    await assert($`exit 4`.cwd(dir).junit("pass.xml")).rejects.toThrow("exit 4 exited with 4")
    await assert($`true`.cwd(dir).junit("none.xml")).rejects.toThrow("true did not write none.xml")
  })

  test("sarif fails on errors, not warnings", async () => {
    const dir = await tmp()
    await Bun.write(`${dir}/clean.sarif`, JSON.stringify({ runs: [{ results: [{ level: "warning", message: { text: "meh" } }] }] }))
    await $`true`.cwd(dir).sarif("clean.sarif")
    await Bun.write(`${dir}/bad.sarif`, JSON.stringify({ runs: [{ results: [{ message: { text: "unsafe" } }] }] }))
    await assert($`true`.cwd(dir).sarif("bad.sarif")).rejects.toThrow("unsafe")
  })

  test("tests reads counts even from a failing run", async () => {
    assert(await $`printf ' 3 pass\n 1 skip\n 1 fail\n'; exit 1`.tests()).toEqual({ tests: 5, passed: 3, failed: 1, skipped: 1 })
    await assert($`echo hello`.tests()).rejects.toThrow("echo hello: no test summary in its output")
  })

  test("samples reads bencher output", async () => {
    assert(await $`echo 'test a ... bench:       1,200 ns/iter (+/- 3)'`.samples()).toEqual([1200])
    await assert($`echo nothing`.samples()).rejects.toThrow("no bencher samples")
  })
})

describe("test counts", () => {
  test("unittest", () => {
    assert(testCounts("Ran 3 tests in 0.1s\n\nFAILED (failures=1, errors=1, skipped=1)")).toEqual({ tests: 3, passed: 0, failed: 2, skipped: 1 })
    assert(testCounts("Ran 1 test in 0s\n\nOK")).toEqual({ tests: 1, passed: 1, failed: 0, skipped: 0 })
  })

  test("cargo sums every test binary", () => {
    assert(testCounts("test result: ok. 2 passed; 0 failed; 1 ignored\ntest result: ok. 1 passed; 0 failed; 0 ignored")).toEqual({
      tests: 4,
      passed: 3,
      failed: 0,
      skipped: 1,
    })
  })

  test("jest and vitest", () => {
    assert(testCounts("Test Suites: 1 passed\nTests:       1 skipped, 2 passed, 3 total")).toEqual({ tests: 3, passed: 2, failed: 0, skipped: 1 })
  })

  test("pytest", () => {
    assert(testCounts("5 passed, 1 skipped, 2 failed in 0.3s")).toEqual({ tests: 8, passed: 5, failed: 2, skipped: 1 })
  })

  test("bun counts todos as skipped", () => {
    assert(testCounts(" 2 pass\n 1 todo\n 0 fail")).toEqual({ tests: 3, passed: 2, failed: 0, skipped: 1 })
  })

  test("no summary", () => {
    assert(testCounts("nothing here")).toBeUndefined()
  })
})

describe("parsers", () => {
  test("junit errors", () => {
    assert(junitFindings(`<testcase name="t"><error/></testcase>`)).toEqual(["t: error"])
  })

  test("sarif locations", () => {
    assert(sarifFindings(JSON.stringify({ runs: [{ results: [{ locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 3 } } }] }] }] }))).toEqual([
      "(no message) (a.ts:3)",
    ])
    assert(sarifFindings(JSON.stringify({ runs: [{ results: [{ message: { text: "x" }, locations: [{ physicalLocation: { artifactLocation: { uri: "b.ts" } } }] }] }, {}] }))).toEqual([
      "x (b.ts)",
    ])
    assert(sarifFindings("{}")).toEqual([])
  })

  test("bencher samples", () => {
    assert(samples("bench: 5 ns/iter\nbench: 7 ns/iter")).toEqual([5, 7])
  })
})

describe("stats", () => {
  test("normal cdf", () => {
    assert(normalCdf(0)).toBeCloseTo(0.5, 6)
    assert(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    assert(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })

  test("compare is confident about clear differences", () => {
    assert(compare([10, 11, 10, 11], [5, 6, 5, 6]).confidence).toBeGreaterThan(0.99)
    assert(compare([5, 6, 5, 6], [10, 11, 10, 11]).confidence).toBeLessThan(0.01)
  })

  test("compare with single samples", () => {
    assert(compare([5], [5]).confidence).toBe(0.5)
    assert(compare([5], [4]).confidence).toBe(1)
    assert(compare([4], [5]).confidence).toBe(0)
  })

  test("compare needs samples", () => {
    assert(() => compare([], [1])).toThrow("need samples")
  })
})
