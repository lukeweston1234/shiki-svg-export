import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './style.css'

import { bundledLanguagesInfo, bundledThemesInfo, createHighlighter, type Highlighter } from 'shiki'
import { FONTS, loadFont } from './fonts'
import { render, type RenderOptions } from './render'

// ---------- state ----------

interface State {
  lang: string
  theme: string
  font: string
  fontSize: number
  lineHeight: number
  paddingX: number
  paddingY: number
  radius: number
  tabSize: number
  mode: RenderOptions['mode']
  scale: number
  background: boolean
  lineNumbers: boolean
  code: string
  /** True while the editor holds an untouched language sample (so switching language swaps it). */
  codeIsSample: boolean
}

const DEFAULTS: State = {
  lang: 'typescript',
  theme: 'vitesse-dark',
  font: 'jetbrains-mono',
  fontSize: 14,
  lineHeight: 1.6,
  paddingX: 24,
  paddingY: 20,
  radius: 12,
  tabSize: 2,
  mode: 'outline',
  scale: 1,
  background: true,
  lineNumbers: false,
  code: `import { createHighlighter } from 'shiki'

const highlighter = await createHighlighter({
  themes: ['vitesse-dark'],
  langs: ['typescript'],
})

export const html = highlighter.codeToHtml('const a = 1', {
  lang: 'typescript',
  theme: 'vitesse-dark',
})
`,
  codeIsSample: true,
}

const STORAGE_KEY = 'shiki-svg-export:v1'

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULTS }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

const state = loadState()

// ---------- dom ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const el = {
  lang: $<HTMLSelectElement>('lang'),
  theme: $<HTMLSelectElement>('theme'),
  font: $<HTMLSelectElement>('font'),
  fontSize: $<HTMLInputElement>('fontSize'),
  lineHeight: $<HTMLInputElement>('lineHeight'),
  lhPx: $('lhPx'),
  paddingX: $<HTMLInputElement>('paddingX'),
  paddingY: $<HTMLInputElement>('paddingY'),
  radius: $<HTMLInputElement>('radius'),
  tabSize: $<HTMLInputElement>('tabSize'),
  mode: $<HTMLSelectElement>('mode'),
  scale: $<HTMLSelectElement>('scale'),
  background: $<HTMLInputElement>('background'),
  lineNumbers: $<HTMLInputElement>('lineNumbers'),
  code: $<HTMLTextAreaElement>('code'),
  stage: $('stage'),
  meta: $('meta'),
  warn: $('warn'),
  status: $('status'),
  sampleNote: $('sampleNote'),
  copy: $<HTMLButtonElement>('copy'),
  download: $<HTMLButtonElement>('download'),
  png: $<HTMLButtonElement>('png'),
}

function option(value: string, label: string) {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}

el.lang.append(option('text', 'Plain Text'))
for (const l of [...bundledLanguagesInfo].sort((a, b) => a.name.localeCompare(b.name))) {
  el.lang.append(option(l.id, l.name))
}

for (const type of ['dark', 'light'] as const) {
  const group = document.createElement('optgroup')
  group.label = type === 'dark' ? 'Dark' : 'Light'
  for (const t of bundledThemesInfo.filter((t) => t.type === type)) {
    group.append(option(t.id, t.displayName))
  }
  el.theme.append(group)
}

for (const f of FONTS) el.font.append(option(f.id, f.family))

// Push state into controls.
el.lang.value = state.lang
el.theme.value = state.theme
el.font.value = state.font
el.fontSize.value = String(state.fontSize)
el.lineHeight.value = String(state.lineHeight)
el.paddingX.value = String(state.paddingX)
el.paddingY.value = String(state.paddingY)
el.radius.value = String(state.radius)
el.tabSize.value = String(state.tabSize)
el.mode.value = state.mode
el.scale.value = String(state.scale)
el.background.checked = state.background
el.lineNumbers.checked = state.lineNumbers
el.code.value = state.code

// ---------- helpers ----------

/** Expand tabs to real tab stops (column-aware), not a flat replace. */
function expandTabs(code: string, size: number): string {
  return code
    .split('\n')
    .map((line) => {
      if (!line.includes('\t')) return line
      let out = ''
      for (const ch of line) {
        if (ch === '\t') out += ' '.repeat(size - ([...out].length % size))
        else out += ch
      }
      return out
    })
    .join('\n')
}

function normalise(code: string, tabSize: number): string {
  return expandTabs(code.replace(/\r\n?/g, '\n'), tabSize).replace(/\s+$/, '')
}

async function fetchSample(lang: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/shikijs/textmate-grammars-themes/main/samples/${lang}.sample`,
    )
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

function fileBase() {
  return `${state.lang}-${state.theme}`
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

let statusTimer = 0
function flash(msg: string) {
  el.status.textContent = msg
  clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => (el.status.textContent = ''), 2200)
}

// ---------- highlight + render ----------

let highlighter: Highlighter | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) highlighter = await createHighlighter({ themes: [], langs: [] })
  const hl = highlighter
  if (state.lang !== 'text' && !hl.getLoadedLanguages().includes(state.lang)) {
    await hl.loadLanguage(state.lang as never)
  }
  if (!hl.getLoadedThemes().includes(state.theme)) await hl.loadTheme(state.theme as never)
  return hl
}

function options(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    paddingX: state.paddingX,
    paddingY: state.paddingY,
    radius: state.radius,
    lineNumbers: state.lineNumbers,
    background: state.background,
    mode: state.mode,
    scale: state.scale,
    ...over,
  }
}

async function build(over: Partial<RenderOptions> = {}) {
  const [hl, font] = await Promise.all([
    getHighlighter(),
    loadFont(FONTS.find((f) => f.id === state.font) ?? FONTS[0]),
  ])
  const code = normalise(state.code, state.tabSize)
  const theme = hl.getTheme(state.theme)
  const result = hl.codeToTokens(code, { lang: state.lang as never, theme: state.theme })
  return render(
    font,
    {
      tokens: result.tokens,
      fg: result.fg ?? theme.fg,
      bg: result.bg ?? theme.bg,
      lineNumberColor: theme.colors?.['editorLineNumber.foreground'],
    },
    options(over),
  )
}

let seq = 0
async function update() {
  const my = ++seq
  saveState()
  el.lhPx.textContent = `× · ${+(state.fontSize * state.lineHeight).toFixed(3)}px`
  el.code.style.tabSize = String(state.tabSize)
  const family = FONTS.find((f) => f.id === state.font)?.family
  el.code.style.fontFamily = `'${family}', ui-monospace, monospace`
  try {
    const r = await build({ scale: 1 })
    if (my !== seq) return
    el.stage.innerHTML = r.svg
    const sc = state.scale
    el.meta.textContent =
      sc === 1 ? `${r.width} × ${r.height}` : `${r.width} × ${r.height} → ${r.width * sc} × ${r.height * sc} @${sc}×`
    if (r.missing.length) {
      el.warn.hidden = false
      el.warn.textContent = `Not in font (shown as boxes): ${r.missing.slice(0, 24).join(' ')}${r.missing.length > 24 ? ' …' : ''}`
    } else {
      el.warn.hidden = true
    }
  } catch (err) {
    if (my !== seq) return
    console.error(err)
    el.meta.textContent = 'Error — see console'
  }
}

// ---------- events ----------

const num = (input: HTMLInputElement, fallback: number) => {
  const v = parseFloat(input.value)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

const bind = (input: HTMLElement, fn: () => void, evt = 'input') =>
  input.addEventListener(evt, () => {
    fn()
    update()
  })

bind(el.theme, () => (state.theme = el.theme.value), 'change')
bind(el.font, () => (state.font = el.font.value), 'change')
bind(el.fontSize, () => (state.fontSize = num(el.fontSize, DEFAULTS.fontSize) || DEFAULTS.fontSize))
bind(el.lineHeight, () => (state.lineHeight = num(el.lineHeight, DEFAULTS.lineHeight) || DEFAULTS.lineHeight))
bind(el.paddingX, () => (state.paddingX = num(el.paddingX, 0)))
bind(el.paddingY, () => (state.paddingY = num(el.paddingY, 0)))
bind(el.radius, () => (state.radius = num(el.radius, 0)))
bind(el.tabSize, () => (state.tabSize = Math.max(1, Math.round(num(el.tabSize, 2)))))
bind(el.mode, () => (state.mode = el.mode.value as RenderOptions['mode']), 'change')
bind(el.scale, () => (state.scale = Number(el.scale.value)), 'change')
bind(el.background, () => (state.background = el.background.checked), 'change')
bind(el.lineNumbers, () => (state.lineNumbers = el.lineNumbers.checked), 'change')
bind(el.code, () => {
  state.code = el.code.value
  state.codeIsSample = false
})

el.lang.addEventListener('change', async () => {
  state.lang = el.lang.value
  if (state.codeIsSample && state.lang !== 'text') {
    el.sampleNote.textContent = 'loading sample…'
    const sample = await fetchSample(state.lang)
    el.sampleNote.textContent = ''
    if (sample && state.codeIsSample && state.lang === el.lang.value) {
      state.code = sample
      el.code.value = sample
    }
  }
  update()
})

// Keep Tab inside the editor.
el.code.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return
  e.preventDefault()
  document.execCommand('insertText', false, '\t')
})

el.copy.addEventListener('click', async () => {
  const { svg } = await build()
  await navigator.clipboard.writeText(svg)
  flash('SVG copied — paste straight into Figma')
})

el.download.addEventListener('click', async () => {
  const { svg } = await build()
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase()}.svg`)
})

el.png.addEventListener('click', async () => {
  // Always rasterise the outlined version: an SVG drawn into <img> can't see web fonts.
  // Intrinsic size already at export scale, so the raster is drawn 1:1 (no resampling).
  const sc = state.scale
  const r = await build({ mode: 'outline', scale: sc })
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = r.width * sc
  canvas.height = r.height * sc
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  canvas.toBlob((b) => b && downloadBlob(b, `${fileBase()}@${sc}x.png`), 'image/png')
})

update()
