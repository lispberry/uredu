// A session evaluates a project's rules against one change: base..head, where head is a snapshot of the
// working tree (or of the index, for pre-commit). `plan` shows what is owed without running anything;
// `run` runs it.
import { join } from "node:path"
import type { Expectation, ExpectationSpec, RunContext, Runner, Verdict } from "../expect.ts"
import type { Project } from "../project.ts"
import { claimOf } from "../proof.ts"
import { evaluate, type AnyRule, type Evaluation } from "../rule.ts"
import type { Step, Workflow } from "../workflow.ts"
import { RepoFacts, type Forecast, type GithubInfo, type TaskInfo } from "./facts.ts"
import { Git } from "./git.ts"
import { Layout } from "./layout.ts"
import { Revisions } from "./revs.ts"
import { ProofRunner, targets, type RunRecord } from "./runner.ts"

export interface SessionOptions {
  readonly cwd: string
  /** Project to evaluate; defaults to the default export of <repo>/proven.ts. */
  readonly project?: Project
  /** Revision the change is measured from. Default: HEAD. */
  readonly base?: string
  /** What head is: the working tree (default), the index (pre-commit) or an existing revision. */
  readonly head?: "worktree" | "index" | { readonly rev: string }
  readonly task?: TaskInfo
  readonly github?: GithubInfo
  readonly rounds?: number
  readonly cache?: boolean
}

export interface ExpectationReport {
  readonly proof: string
  readonly claim: string
  readonly matcher: string
  readonly at: string | undefined
  readonly dirs: readonly string[]
  readonly verdict: Verdict
}

export interface RuleReport {
  readonly title: string
  readonly fired: boolean
  readonly reason: string
  readonly waived?: string
  readonly item?: unknown
  readonly expectations: readonly ExpectationReport[]
  readonly children: readonly RuleReport[]
}

export interface Report {
  readonly base: string
  readonly head: string
  readonly ok: boolean
  readonly rules: readonly RuleReport[]
  readonly runs: readonly RunRecord[]
}

export async function loadProject(root: string): Promise<Project> {
  const mod = (await import(join(root, "proven.ts"))) as { default?: Project }
  if (mod.default?.kind !== "project") throw new Error(`${join(root, "proven.ts")} must default-export project({ ... })`)
  return mod.default
}

export class Session {
  private constructor(
    readonly git: Git,
    readonly project: Project,
    readonly layout: Layout,
    readonly revs: Revisions,
    readonly options: SessionOptions,
  ) {}

  static async open(options: SessionOptions): Promise<Session> {
    const git = await Git.open(options.cwd)
    const project = options.project ?? (await loadProject(git.root))
    const base = await git.sha(options.base ?? "HEAD")
    const head = options.head ?? "worktree"
    // snapshots sit on top of HEAD, so base..head includes every commit since base plus uncommitted work
    const headSha =
      head === "worktree" ? await git.snapshot(await git.sha("HEAD")) : head === "index" ? await git.snapshotIndex(await git.sha("HEAD")) : await git.sha(head.rev)
    return new Session(git, project, new Layout(project.providers), new Revisions(git, base, headSha), options)
  }

  facts(task: TaskInfo = this.options.task ?? { intent: "change", declares: [] }, forecast?: Forecast): RepoFacts {
    return new RepoFacts({ git: this.git, layout: this.layout, revs: this.revs, task, github: this.options.github, forecast })
  }

  /** What the change owes, without running anything. */
  plan(opts: { task?: TaskInfo; forecast?: Forecast; waive?: ReadonlyMap<AnyRule, string>; extra?: readonly Expectation[] } = {}): Promise<Report> {
    const facts = this.facts(opts.task, opts.forecast)
    const planner: Runner = {
      run: async (spec, _signal, context) =>
        (await targets(spec, context, this.layout, facts)).length
          ? { ok: true, planned: true, findings: [], artifacts: [] }
          : { ok: false, planned: true, findings: [{ message: `no provider binds ${spec.proof.name}`, severity: "error" }], artifacts: [] },
    }
    return this.evaluate(facts, planner, [], opts.waive, opts.extra)
  }

  /** Run every owed proof. */
  run(opts: { task?: TaskInfo; waive?: ReadonlyMap<AnyRule, string>; extra?: readonly Expectation[]; signal?: AbortSignal } = {}): Promise<Report> {
    const facts = this.facts(opts.task)
    const runner = new ProofRunner({
      git: this.git,
      layout: this.layout,
      revs: this.revs,
      facts,
      rounds: this.options.rounds,
      cache: this.options.cache,
      setup: this.project.setup,
      env: this.project.env,
    })
    return this.evaluate(facts, runner, runner.records, opts.waive, opts.extra, opts.signal)
  }

  /** Plan one workflow step: its forecast, intent, skips and extra expectations. */
  async planStep(workflow: Workflow, step: Step): Promise<Report> {
    if (!workflow.steps.includes(step)) throw new Error(`step "${step.id}" is not in workflow "${workflow.title}"`)
    const forecast: Forecast = {
      areas: step.expects.map((e) => (e.kind === "area" ? e.name : e.area.name)),
      symbols: Object.fromEntries(step.expects.flatMap((e) => (e.kind === "areaChange" ? [[e.area.name, [e.symbol]]] : []))),
    }
    return this.plan({
      task: { intent: step.intent, declares: [] },
      forecast,
      waive: new Map(step.skip.map((s) => [s.rule, s.why])),
      extra: step.done,
    })
  }

  private async evaluate(
    facts: RepoFacts,
    runner: Runner,
    runs: readonly RunRecord[],
    waive: ReadonlyMap<AnyRule, string> | undefined,
    extra: readonly Expectation[] = [],
    signal?: AbortSignal,
  ): Promise<Report> {
    const [evaluations, extras] = await Promise.all([
      Promise.all(this.project.rules.map((rule) => evaluate(rule, { facts, runner, waive, signal }))),
      Promise.all(extra.map((e) => this.extra(e.spec, runner, facts, signal ?? new AbortController().signal))),
    ])
    const rules = await Promise.all(evaluations.map((e) => this.report(e, facts)))
    if (extras.length) rules.push({ title: "Step expectations", fired: true, reason: "declared by the step", expectations: extras, children: [] })
    return { base: this.revs.base, head: this.revs.head, ok: rules.every(ok), rules, runs }
  }

  private async extra(spec: ExpectationSpec, runner: Runner, facts: RepoFacts, signal: AbortSignal): Promise<ExpectationReport> {
    const context: RunContext = { rule: undefined, item: undefined }
    const [verdict, dirs] = await Promise.all([runner.run(spec, signal, context), targets(spec, context, this.layout, facts)])
    return expectationReport(spec, verdict, dirs.map((d) => d.dir))
  }

  private async report(e: Evaluation, facts: RepoFacts): Promise<RuleReport> {
    const reason = e.waived !== undefined ? `waived: ${e.waived}` : await this.reason(e, facts)
    const context: RunContext = { rule: e.rule, item: e.item }
    const expectations = await Promise.all(
      e.results.map(async (r) => expectationReport(r.spec, r.verdict, (await targets(r.spec, context, this.layout, facts)).map((t) => t.dir))),
    )
    return {
      title: e.rule.title,
      fired: e.fired,
      reason,
      waived: e.waived,
      item: e.item,
      expectations,
      children: await Promise.all(e.children.map((c) => this.report(c, facts))),
    }
  }

  private async reason(e: Evaluation, facts: RepoFacts): Promise<string> {
    if (e.item !== undefined) return `for ${String(e.item)}`
    if (e.rule.when) return (await facts.explain(e.rule.when)).reason
    if (e.rule.each) return e.fired ? `${e.children.length} item(s)` : "no items"
    return "always"
  }
}

function expectationReport(spec: ExpectationSpec, verdict: Verdict, dirs: readonly string[]): ExpectationReport {
  return {
    proof: spec.proof.name,
    claim: claimOf(spec.proof, spec.args),
    matcher: spec.matcher.kind,
    at: spec.at?.ref,
    dirs,
    verdict,
  }
}

const ok = (r: RuleReport): boolean => r.expectations.every((e) => e.verdict.ok) && r.children.every(ok)
