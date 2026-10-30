// Shared output shapes for abstract claims.
import { z } from "zod"

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** PNG image bytes, e.g. a screenshot. */
export const png = z.instanceof(Uint8Array).refine((b) => pngSignature.every((x, i) => b[i] === x), "not a PNG image")
