/**
 * Derives a restrained ambient colour from artwork.
 *
 * Section 12 asks the interface to feel connected to the current title without
 * tinting the whole UI or letting a bright poster wash out text. Two rules make
 * that safe, and both are enforced here rather than at the call site:
 *
 *  - Lightness is *set*, never inherited. However bright the artwork, the
 *    result is always a dark tint, so it can only ever darken a surface.
 *  - Saturation is capped. Highly saturated key art would otherwise produce a
 *    strong colour cast across the page.
 *
 * Sampling is done once per artwork change on an 8x8 downscale, which is the
 * same technique (and cost) HeroSection already uses to detect blank backdrops.
 */

const SAMPLE_SIZE = 8
/** Ceiling on how colourful the ambient tint may become. */
const MAX_SATURATION = 0.5
/** Fixed lightness: guarantees the tint is always darker than any text on it. */
const AMBIENT_LIGHTNESS = 0.2

export interface AmbientColor {
  r: number
  g: number
  b: number
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255
  const gf = g / 255
  const bf = b / 255
  const max = Math.max(rf, gf, bf)
  const min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6
  else if (max === gf) h = ((bf - rf) / d + 2) / 6
  else h = ((rf - gf) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): AmbientColor {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  }
}

/**
 * Returns null when the colour cannot be read — most often because the artwork
 * is cross-origin without CORS headers, which taints the canvas. Callers must
 * treat that as "no ambient colour" and leave their default styling alone.
 */
export function extractAmbientColor(image: HTMLImageElement): AmbientColor | null {
  if (!image.naturalWidth || !image.naturalHeight) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue
      // Near-black and near-white pixels carry no usable hue and would drag the
      // average toward grey, which is how "ambient colour" turns into "ambient
      // sludge" on letterboxed or heavily graded artwork.
      const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722
      if (luma < 24 || luma > 232) continue
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      count += 1
    }
    if (count === 0) return null

    const [h, s] = rgbToHsl(r / count, g / count, b / count)
    return hslToRgb(h, Math.min(s, MAX_SATURATION), AMBIENT_LIGHTNESS)
  } catch {
    // Tainted canvas (cross-origin artwork) or an unreadable decode.
    return null
  }
}

/**
 * Loads `url` and resolves its ambient colour, or null if unavailable.
 *
 * The image must be requested with `crossOrigin`, otherwise drawing it taints
 * the canvas and getImageData throws — the hero's own <img> is loaded without
 * CORS, so it can never be sampled directly.
 *
 * That creates a cache collision: the browser may already hold a non-CORS
 * response for this exact URL from the hero, and reusing it fails the
 * `anonymous` request. The retry re-requests under a distinct cache key so the
 * fetch happens again with CORS headers attached. Providers ignore the extra
 * parameter, and it only ever costs a second request when the first failed.
 */
function decode(url: string, signal?: AbortSignal): Promise<AmbientColor | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const done = (value: AmbientColor | null) => {
      image.onload = null
      image.onerror = null
      resolve(value)
    }
    image.onload = () => done(signal?.aborted ? null : extractAmbientColor(image))
    image.onerror = () => done(null)
    signal?.addEventListener('abort', () => done(null), { once: true })
    image.src = url
  })
}

export async function loadAmbientColor(
  url: string,
  signal?: AbortSignal,
): Promise<AmbientColor | null> {
  const direct = await decode(url, signal)
  if (direct || signal?.aborted) return direct
  const separator = url.includes('?') ? '&' : '?'
  return decode(`${url}${separator}auralesAmbient=1`, signal)
}
