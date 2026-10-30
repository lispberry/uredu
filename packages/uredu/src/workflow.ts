// A workflow is the task: steps an agent writes, each listing the claims it must meet. It doesn't import the
// project; uredu.ts registers its type once, and a step whose claims the project can't prove doesn't compile.
//
//   declare module "uredu" { interface Register { project: typeof config } }
//
//   export default workflow("Players can fire homing missiles", [noNewCrashes], ({ step }) => {
//     const sim = step("Missiles simulate", [game])
//     step("HUD shows lock-on", [ui, game], { after: [sim] })
//   })
import type { AnyClaim, NeedsOf } from "./claim.ts"
import type { Project } from "./project.ts"

/** Augmented by uredu.ts: `declare module "uredu" { interface Register { project: typeof config } }`. */
// oxlint-disable-next-line no-empty-interface -- filled in by module augmentation
export interface Register {}

type Provided = Register extends { project: Project<infer P> } ? P : never
type Registered = Register extends { project: Project<string> } ? true : false

type Unprovided<Ps extends readonly AnyClaim[]> =
  NeedsOf<Ps[number]> extends infer N
    ? N extends readonly [infer A extends string, infer P extends string]
      ? A extends Provided
        ? never
        : `claim '${A}'${P extends "" ? "" : ` (${P})`} is not provided in uredu.ts`
      : never
    : never
/** A plain string when the project proves everything the claims need; otherwise the errors, which no title matches. */
type Title<Ps extends readonly AnyClaim[]> = Registered extends true ? ([Unprovided<Ps>] extends [never] ? string : Unprovided<Ps>) : "register your project in uredu.ts"

export interface StepOptions {
  readonly after?: readonly Step[]
  /** Files the step is expected to write. */
  readonly produces?: readonly string[]
}

export interface Step {
  readonly kind: "step"
  readonly id: string
  readonly title: string
  readonly claims: readonly AnyClaim[]
  readonly after: readonly Step[]
  readonly produces: readonly string[]
}

export interface Workflow {
  readonly kind: "workflow"
  readonly title: string
  /** Owed by every step. */
  readonly claims: readonly AnyClaim[]
  readonly steps: readonly Step[]
}

export interface WorkflowContext {
  step<const Ps extends readonly AnyClaim[]>(title: NoInfer<Title<Ps>>, claims: Ps, options?: StepOptions): Step
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export function workflow<const Ps extends readonly AnyClaim[]>(title: NoInfer<Title<Ps>>, claims: Ps, body: (ctx: WorkflowContext) => void): Workflow {
  const steps: Step[] = []
  body({
    step(stepTitle, stepClaims, options = {}) {
      const id = slug(stepTitle)
      if (steps.some((s) => s.id === id)) throw new Error(`workflow "${title}": duplicate step "${id}"`)
      const step: Step = { kind: "step", id, title: stepTitle, claims: stepClaims, after: options.after ?? [], produces: options.produces ?? [] }
      steps.push(step)
      return step
    },
  })
  return { kind: "workflow", title, claims, steps }
}
