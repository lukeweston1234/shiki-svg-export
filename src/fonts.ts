import { parse, type Font } from 'opentype.js'

export type Variant = 'regular' | 'bold' | 'italic' | 'boldItalic'

/**
 * Every bundled monospace WOFF (all Fontsource subsets, 400/700, normal/italic).
 * WOFF (not WOFF2) because opentype.js can parse it directly — the same bytes drive
 * both the browser preview (@font-face) and the outline/metrics maths, so they agree.
 */
const files = import.meta.glob<string>(
  '/node_modules/@fontsource/{jetbrains-mono,fira-code,ibm-plex-mono,geist-mono}/files/*-{400,700}-{normal,italic}.woff',
  { query: '?url', import: 'default', eager: true },
)

export interface FontDef {
  id: string
  /** Family name used in exported live-text SVGs — must match the font installed in Figma. */
  family: string
}

export const FONTS: FontDef[] = [
  { id: 'jetbrains-mono', family: 'JetBrains Mono' },
  { id: 'geist-mono', family: 'Geist Mono' },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono' },
  { id: 'fira-code', family: 'Fira Code' },
]

const VARIANT_FILE: Record<Variant, [weight: number, style: 'normal' | 'italic']> = {
  regular: [400, 'normal'],
  bold: [700, 'normal'],
  italic: [400, 'italic'],
  boldItalic: [700, 'italic'],
}

const UPRIGHT: Record<Variant, Variant> = {
  regular: 'regular',
  bold: 'bold',
  italic: 'regular',
  boldItalic: 'bold',
}

/** Subset file URLs for a variant, latin first then latin-ext, then the rest. */
function urlsFor(id: string, v: Variant): string[] {
  const [w, s] = VARIANT_FILE[v]
  const prefix = `/node_modules/@fontsource/${id}/files/${id}-`
  const suffix = `-${w}-${s}.woff`
  const rank = (sub: string) => (sub === 'latin' ? 0 : sub === 'latin-ext' ? 1 : 2)
  return Object.keys(files)
    .filter((k) => k.startsWith(prefix) && k.endsWith(suffix))
    .map((k) => ({ k, sub: k.slice(prefix.length, -suffix.length) }))
    .sort((a, b) => rank(a.sub) - rank(b.sub) || a.sub.localeCompare(b.sub))
    .map(({ k }) => files[k])
}

export interface FaceFont {
  font: Font
  /** True when this is an upright cut standing in for an italic: outlines get slanted. */
  slant: boolean
}

export interface FaceSet {
  /** Ordered per-glyph fallback chain. */
  fonts: FaceFont[]
}

export interface LoadedFont {
  def: FontDef
  faces: Record<Variant, FaceSet>
  /** Vertical metrics in font units (hhea — what Chrome/macOS and Figma use for line boxes). */
  unitsPerEm: number
  ascender: number
  descender: number
  underlinePosition: number
  underlineThickness: number
  strikeoutPosition: number
  strikeoutSize: number
}

const cache = new Map<string, Promise<LoadedFont>>()
const parsed = new Map<string, Promise<Font>>()

function fetchFont(url: string): Promise<Font> {
  let p = parsed.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => parse(b))
    parsed.set(url, p)
  }
  return p
}

async function registerFaces(family: string, urls: string[], v: Variant) {
  const [weight, style] = VARIANT_FILE[v]
  // Same-descriptor faces form a composite: the last added is tried first and missing
  // glyphs fall through to earlier ones — so add in reverse priority (latin last).
  const faces = [...urls].reverse().map(
    (u) => new FontFace(family, `url(${u}) format('woff')`, { weight: String(weight), style }),
  )
  await Promise.all(faces.map((f) => f.load()))
  for (const f of faces) document.fonts.add(f)
}

export function loadFont(def: FontDef): Promise<LoadedFont> {
  let p = cache.get(def.id)
  if (p) return p
  p = (async () => {
    const variants: Variant[] = ['regular', 'bold', 'italic', 'boldItalic']
    const faces = {} as Record<Variant, FaceSet>
    await Promise.all(
      variants.map(async (v) => {
        const own = urlsFor(def.id, v)
        const upright = v === UPRIGHT[v] ? [] : urlsFor(def.id, UPRIGHT[v])
        const [ownFonts, uprightFonts] = await Promise.all([
          Promise.all(own.map(fetchFont)),
          Promise.all(upright.map(fetchFont)),
        ])
        faces[v] = {
          fonts: [
            ...ownFonts.map((font) => ({ font, slant: false })),
            // Glyphs with no italic cut (or a family with no italics at all) fall back to
            // the upright design, slanted — like a browser's synthetic oblique.
            ...uprightFonts.map((font) => ({ font, slant: true })),
          ],
        }
        if (own.length) await registerFaces(def.family, own, v)
      }),
    )
    const base = faces.regular.fonts[0].font
    const post = base.tables.post as unknown as { underlinePosition: number; underlineThickness: number }
    const os2 = base.tables.os2 as unknown as { yStrikeoutPosition: number; yStrikeoutSize: number }
    return {
      def,
      faces,
      unitsPerEm: base.unitsPerEm,
      ascender: base.ascender,
      descender: base.descender,
      underlinePosition: post.underlinePosition,
      underlineThickness: post.underlineThickness || Math.round(base.unitsPerEm / 20),
      strikeoutPosition: os2.yStrikeoutPosition,
      strikeoutSize: os2.yStrikeoutSize || Math.round(base.unitsPerEm / 20),
    }
  })()
  cache.set(def.id, p)
  return p
}
