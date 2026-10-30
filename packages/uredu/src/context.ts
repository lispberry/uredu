// Where a running claim is: which part of the repo, at which revision, inside which claim. Claim calls,
// `$` and the built-in facts read it, so claim bodies and implementations need no context parameter.
import { AsyncLocalStorage } from "node:async_hooks"
import type { AnyClaim } from "./claim.ts"

export interface Rev {
  readonly kind: "rev"
  /** "base" | "head" | "merge-base:<ref>" | "ref:<ref>" */
  readonly ref: string
}

export interface CallOptions {
  /** Run at this revision instead of the caller's. */
  readonly at?: Rev
  /** Files (relative to the part) copied from head onto that revision first. */
  readonly overlay?: readonly string[]
  /** Never use or write cached outputs (timing runs). */
  readonly fresh?: boolean
  /** The claim must fail; failing is success. */
  readonly fail?: boolean
}

export interface Change {
  /** Relative to the part's directory. */
  readonly path: string
  readonly status: "added" | "modified" | "deleted"
}

/** What the engine offers to code running inside a claim. */
export interface Engine {
  call(claim: AnyClaim, input: unknown, options: CallOptions): Promise<unknown>
  changes(): Promise<readonly Change[]>
  commits(): Promise<readonly { readonly sha: string; readonly subject: string }[]>
  readonly step: string | undefined
  readonly workflow: string | undefined
}

/** One evaluated claim or call, in the report tree. */
export interface Node {
  readonly title: string
  readonly type: "abstract" | "derived" | "group"
  readonly part: string
  status: "passed" | "failed" | "owed" | "missing"
  readonly findings: string[]
  readonly children: Node[]
  /** Abstract calls: their input, revision label and whether the verdict came from the cache. */
  readonly input?: unknown
  readonly at?: string
  cached?: boolean
  /** The call required the claim to fail. */
  readonly fail?: boolean
}

export interface Context {
  readonly engine: Engine
  /** The claim whose body is running, if any; only its deps may be called. */
  readonly within: AnyClaim | undefined
  /** Repo-relative directory of the part being uredu ("." for the root). */
  readonly part: string
  /** The revision calls run at unless they say otherwise. */
  readonly sha: string
  /** Where calls are recorded. */
  readonly node: Node
  /** Calls started by the running body, awaited before it counts as done. */
  readonly pending: Promise<unknown>[]
  /** Absolute working directory for commands: the part's directory in a worktree at the current revision. */
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Where commands append their output. */
  readonly log: string | undefined
}

export const storage = new AsyncLocalStorage<Context>()

export function current(): Context {
  const ctx = storage.getStore()
  if (!ctx) throw new Error("claims run inside uredu: use `uredu run`, or Session.run() in tests")
  return ctx
}
