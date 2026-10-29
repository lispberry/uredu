#!/usr/bin/env bun
import { main } from "./cli.ts"

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: () => Bun.stdin.text(),
  out: (t) => console.log(t),
  err: (t) => console.error(t),
})
