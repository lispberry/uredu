// Comparing timing samples from interleaved base and head runs.

export interface Comparison {
  readonly baseMean: number
  readonly headMean: number
  /** Confidence that head is faster (smaller) than base, in [0, 1]. */
  readonly confidence: number
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const variance = (xs: readonly number[], m: number) => (xs.length < 2 ? 0 : xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** Welch's comparison of means with a normal approximation. */
export function compare(base: readonly number[], head: readonly number[]): Comparison {
  if (!base.length || !head.length) throw new Error("compare: need samples from both revisions")
  const baseMean = mean(base)
  const headMean = mean(head)
  const se = Math.sqrt(variance(base, baseMean) / base.length + variance(head, headMean) / head.length)
  const confidence = se === 0 ? (headMean < baseMean ? 1 : headMean > baseMean ? 0 : 0.5) : normalCdf((baseMean - headMean) / se)
  return { baseMean, headMean, confidence }
}
