import type { Font, Glyph as OTGlyph, PathCommand } from 'opentype.js'
import type { ThemedToken } from 'shiki'
import type { FaceSet, LoadedFont, Variant } from './fonts'

export interface RenderOptions {
  fontSize: number
  /** Line height as a multiple of font size. */
  lineHeight: number
  paddingX: number
  paddingY: number
  radius: number
  lineNumbers: boolean
  background: boolean
  /** 'outline' = glyphs as vector paths (pixel-exact anywhere); 'text' = editable <text> layers. */
  mode: 'outline' | 'text'
  /** Multiplies the SVG's width/height attributes; the viewBox stays in 1x units. */
  scale: number
}

export interface RenderInput {
  tokens: ThemedToken[][]
  fg: string
  bg: string
  lineNumberColor?: string
}

export interface RenderResult {
  svg: string
  /** 1x dimensions (viewBox). */
  width: number
  height: number
  /** Characters with no glyph in the chosen font (rendered as .notdef). */
  missing: string[]
}

// Shiki/vscode-textmate FontStyle bit flags.
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4
const STRIKETHROUGH = 8

/** Synthetic oblique angle used when a family ships no italic (matches browsers' ~14°). */
const SLANT = Math.tan((14 * Math.PI) / 180)

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Split 8-digit hex into fill + opacity — Figma's SVG importer ignores alpha in #rrggbbaa. */
export function parseColor(c: string | undefined, fallback: string): { fill: string; opacity: number } {
  let s = (c || fallback).trim().toLowerCase()
  if (/^#[0-9a-f]{3,4}$/.test(s)) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('')
  if (/^#[0-9a-f]{8}$/.test(s)) {
    return { fill: s.slice(0, 7), opacity: Math.round((parseInt(s.slice(7), 16) / 255) * 1000) / 1000 }
  }
  return { fill: s, opacity: 1 }
}

const paint = (c: { fill: string; opacity: number }, attr = 'fill') =>
  `${attr}="${c.fill}"` + (c.opacity < 1 ? ` ${attr}-opacity="${fmt(c.opacity)}"` : '')

function variantOf(fontStyle: number | undefined): Variant {
  const fs = fontStyle && fontStyle > 0 ? fontStyle : 0
  const b = (fs & BOLD) !== 0
  const i = (fs & ITALIC) !== 0
  return b && i ? 'boldItalic' : b ? 'bold' : i ? 'italic' : 'regular'
}

interface Glyph {
  glyph: OTGlyph
  font: Font
  advance: number // font units
  slant: boolean
}

function makeGlyphLookup(missing: Set<string>) {
  const cache = new Map<FaceSet, Map<string, Glyph>>()
  return (face: FaceSet, ch: string): Glyph => {
    let m = cache.get(face)
    if (!m) cache.set(face, (m = new Map()))
    let g = m.get(ch)
    if (g) return g
    for (const { font, slant } of face.fonts) {
      const idx = font.charToGlyphIndex(ch)
      if (idx > 0) {
        const glyph = font.glyphs.get(idx)
        g = { glyph, font, advance: glyph.advanceWidth ?? 0, slant }
        break
      }
    }
    if (!g) {
      missing.add(ch)
      const { font, slant } = face.fonts[0]
      const glyph = font.glyphs.get(0)
      g = { glyph, font, advance: glyph.advanceWidth ?? 0, slant }
    }
    m.set(ch, g)
    return g
  }
}

/** Serialise opentype path commands, optionally slanting around the baseline. */
function pathData(cmds: PathCommand[], baseline: number, slant: number): string {
  const X = (x: number, y: number) => fmt(x + (baseline - y) * slant)
  const Y = (y: number) => fmt(y)
  let d = ''
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
      case 'L':
        d += `${c.type}${X(c.x, c.y)} ${Y(c.y)}`
        break
      case 'Q':
        d += `Q${X(c.x1, c.y1)} ${Y(c.y1)} ${X(c.x, c.y)} ${Y(c.y)}`
        break
      case 'C':
        d += `C${X(c.x1, c.y1)} ${Y(c.y1)} ${X(c.x2, c.y2)} ${Y(c.y2)} ${X(c.x, c.y)} ${Y(c.y)}`
        break
      case 'Z':
        d += 'Z'
        break
    }
  }
  return d
}

interface Run {
  text: string
  x: number
  variant: Variant
  color: { fill: string; opacity: number }
}

export function render(font: LoadedFont, input: RenderInput, o: RenderOptions): RenderResult {
  const missingSet = new Set<string>()
  const lookup = makeGlyphLookup(missingSet)
  const size = o.fontSize
  const s = size / font.unitsPerEm
  const lh = size * o.lineHeight

  // CSS/Figma line box model: content area = ascent + descent, centred in the line box
  // (half-leading on each side). Baseline sits `ascent` below the content-area top.
  const ascent = font.ascender * s
  const descent = -font.descender * s
  const baselineInLine = (lh - (ascent + descent)) / 2 + ascent

  const lines = input.tokens.length ? input.tokens : [[]]

  // Gutter
  const regular = font.faces.regular
  const digitAdv = lookup(regular, '0').advance * s
  const spaceAdv = lookup(regular, ' ').advance * s
  const digits = String(lines.length).length
  const gutter = o.lineNumbers ? digits * digitAdv + spaceAdv * 3 : 0
  const lnColor = parseColor(input.lineNumberColor, input.fg)
  if (!input.lineNumberColor) lnColor.opacity *= 0.45

  const left = o.paddingX + gutter
  const out: string[] = []
  let maxW = 0

  lines.forEach((line, i) => {
    const top = o.paddingY + i * lh
    const baseline = top + baselineInLine
    const backs: string[] = []
    const parts: string[] = []
    const decos: string[] = []

    if (o.lineNumbers) {
      const n = String(i + 1)
      const x = o.paddingX + (digits - n.length) * digitAdv
      parts.push(emitRun({ text: n, x, variant: 'regular', color: lnColor }))
    }

    let x = left
    for (const tok of line) {
      const fs = tok.fontStyle && tok.fontStyle > 0 ? tok.fontStyle : 0
      const variant = variantOf(fs)
      const face = font.faces[variant]
      const color = parseColor(tok.color, input.fg)
      const tokStart = x
      let run: Run | null = null
      // Break at whitespace so every visible run carries an absolute x — importers that
      // collapse or re-measure whitespace (Figma does) can't shift anything.
      for (const ch of tok.content) {
        const adv = lookup(face, ch).advance * s
        if (/\s/.test(ch)) {
          if (run) parts.push(emitRun(run))
          run = null
        } else {
          if (!run) run = { text: '', x, variant, color }
          run.text += ch
        }
        x += adv
      }
      if (run) parts.push(emitRun(run))

      const w = x - tokStart
      if (tok.bgColor) {
        backs.push(
          `<rect x="${fmt(tokStart)}" y="${fmt(top)}" width="${fmt(w)}" height="${fmt(lh)}" ${paint(parseColor(tok.bgColor, input.bg))}/>`,
        )
      }
      if (fs & UNDERLINE) {
        const t = font.underlineThickness * s
        decos.push(
          `<rect x="${fmt(tokStart)}" y="${fmt(baseline - font.underlinePosition * s)}" width="${fmt(w)}" height="${fmt(t)}" ${paint(color)}/>`,
        )
      }
      if (fs & STRIKETHROUGH) {
        const t = font.strikeoutSize * s
        decos.push(
          `<rect x="${fmt(tokStart)}" y="${fmt(baseline - font.strikeoutPosition * s)}" width="${fmt(w)}" height="${fmt(t)}" ${paint(color)}/>`,
        )
      }
    }
    maxW = Math.max(maxW, x - left)

    const body = [...backs, ...parts, ...decos]
    if (body.length) out.push(`<g id="line-${i + 1}">${body.join('')}</g>`)

    function emitRun(r: Run): string {
      const f = font.faces[r.variant]
      if (o.mode === 'outline') {
        let d = ''
        let gx = r.x
        for (const ch of r.text) {
          const g = lookup(f, ch)
          d += pathData(g.glyph.getPath(gx, baseline, size).commands, baseline, g.slant ? SLANT : 0)
          gx += g.advance * s
        }
        return d ? `<path d="${d}" ${paint(r.color)}/>` : ''
      }
      const weight = r.variant === 'bold' || r.variant === 'boldItalic' ? ' font-weight="700"' : ''
      const style = r.variant === 'italic' || r.variant === 'boldItalic' ? ' font-style="italic"' : ''
      return `<text x="${fmt(r.x)}" y="${fmt(baseline)}"${weight}${style} ${paint(r.color)}>${esc(r.text)}</text>`
    }
  })

  // Integer canvas so the Figma frame and raster exports land on whole pixels.
  const width = Math.ceil(o.paddingX * 2 + gutter + maxW)
  const height = Math.ceil(o.paddingY * 2 + lines.length * lh)

  const bg = parseColor(input.bg, '#ffffff')
  const rx = Math.min(o.radius, width / 2, height / 2)
  const bgRect = o.background
    ? `<rect width="${width}" height="${height}"${rx > 0 ? ` rx="${fmt(rx)}"` : ''} ${paint(bg)}/>`
    : ''

  const textAttrs =
    o.mode === 'text'
      ? ` font-family="${esc(font.def.family)}, monospace" font-size="${fmt(size)}" style="font-kerning:none;font-variant-ligatures:none;font-feature-settings:'liga' 0,'calt' 0"`
      : ''

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width * o.scale)}" height="${fmt(height * o.scale)}" viewBox="0 0 ${width} ${height}" fill="none">` +
    bgRect +
    `<g id="code"${textAttrs}>${out.join('')}</g>` +
    `</svg>`

  return { svg, width, height, missing: [...missingSet] }
}
