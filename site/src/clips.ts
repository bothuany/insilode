// What each feature section shows, in one place. A slot is a still of the real app (a headless capture of this site's own canvas
// and pages) until it has a loop: add `video` (the path of a silent, looping clip under public/media/ without its extension; its
// .webm and .mp4 are both offered) and the still becomes its poster. Loops play only while on screen, and never when the visitor
// asks for reduced motion.
import { NAME } from './brand'
import type { DemoData, HarnessItem } from './demo'
import { playWhileVisible } from './loop'

export interface Clip {
  poster: string
  video?: string
  width: number
  height: number
  alt: string
}

export const CLIPS: Record<string, Clip> = {
  // The loops are made from this site's own pages with HyperFrames (site/video).
  reading: {
    poster: 'media/loops/reading-poster.webp',
    video: 'media/loops/reading',
    width: 1600,
    height: 1000,
    alt: `The ${NAME} canvas on POST /orders with its reading pane: l steps into OrderService.place, j steps over to createInvoice, l steps into it, and Enter opens the HTTP call into the Python create_invoice, while the canvas follows as a trace.`,
  },
  changes: {
    poster: 'media/loops/review-poster.webp',
    video: 'media/loops/review',
    width: 1600,
    height: 1000,
    alt: `The ${NAME} canvas after Claude Code added discount codes to orders: the change fans out to the four endpoints it reaches, the canvas reviews its two changed cards, and after Keep on OrderService.applyDiscount the card turns plain.`,
  },
  services: {
    poster: 'media/loops/services-poster.webp',
    video: 'media/loops/services',
    width: 1600,
    height: 1000,
    alt: 'The invoice tour on the canvas: a Java endpoint, its HTTP call to billing, the Python route it reaches, its query and the invoices table.',
  },
  agents: {
    poster: 'media/loops/agents-poster.webp',
    video: 'media/loops/agents',
    width: 1600,
    height: 1000,
    alt: `The Agents page of ${NAME}: Alt+Shift+N opens the waiting Codex session in a pane, then two Claude Code sessions are dragged onto the right and bottom edges and split the workspace.`,
  },
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function clipElement(c: Clip) {
  const img = document.createElement('img')
  img.src = c.poster
  img.alt = c.alt
  img.width = c.width
  img.height = c.height
  img.loading = 'lazy'
  img.decoding = 'async'
  if (!c.video || reduced()) return img
  const v = document.createElement('video')
  for (const [ext, type] of [['webm', 'video/webm'], ['mp4', 'video/mp4']]) {
    const source = document.createElement('source')
    source.src = `${c.video}.${ext}`
    source.type = type
    v.append(source)
  }
  v.poster = c.poster
  v.muted = true
  v.loop = true
  v.playsInline = true
  v.preload = 'none'
  v.width = c.width
  v.height = c.height
  v.setAttribute('aria-label', c.alt)
  playWhileVisible(v)
  return v
}

/** Fills every `[data-clip]` slot on the page. */
export function mountClips() {
  document.querySelectorAll<HTMLElement>('[data-clip]').forEach(slot => {
    const c = CLIPS[slot.dataset.clip!]
    if (c) slot.replaceChildren(clipElement(c))
  })
}

const KINDS: Record<HarnessItem['kind'], string> = {
  instructions: 'Instructions',
  rules: 'Rules',
  skills: 'Skills',
  agents: 'Subagents',
  hooks: 'Hooks',
  mcp: 'MCP servers',
  permissions: 'Permissions',
  memory: 'Memory',
}

/** The harness section shows the real scan of the demo project (flow-harness's own scan, run by scripts/site-data.mjs), drawn here. */
export function mountHarness(slot: HTMLElement, data: DemoData) {
  const h = data.harness
  const groups = new Map<HarnessItem['kind'], HarnessItem[]>()
  for (const item of h.items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
  const head = document.createElement('div')
  head.className = 'hx-head'
  const score = document.createElement('p')
  score.className = 'hx-score'
  score.innerHTML = '<b></b><span>health</span>'
  score.querySelector('b')!.textContent = String(h.score)
  // The ring around the score fills to it (home.css).
  score.style.setProperty('--score', String(h.score))
  const sum = document.createElement('p')
  sum.className = 'hx-sum'
  sum.textContent = `${h.items.length} pieces shape the agent in this project. ${h.startupTokens} tokens are loaded before you type.`
  head.append(score, sum)

  const rows = document.createElement('table')
  rows.className = 'hx-table'
  rows.innerHTML = '<caption class="visually-hidden">The harness of the demo project, by kind</caption><thead><tr><th scope="col">Kind</th><th scope="col">Pieces</th><th scope="col">Tokens at start</th></tr></thead>'
  const body = document.createElement('tbody')
  for (const [kind, items] of groups) {
    const tr = document.createElement('tr')
    const tokens = items.reduce((n, i) => n + (i.tokens ?? 0), 0)
    for (const [i, text] of [KINDS[kind], String(items.length), tokens ? String(tokens) : ''].entries()) {
      const cell = document.createElement(i ? 'td' : 'th')
      if (!i) cell.setAttribute('scope', 'row')
      cell.textContent = text
      tr.append(cell)
    }
    body.append(tr)
  }
  rows.append(body)

  const issues = h.items.flatMap(i => i.issues.map(x => ({ item: i, ...x })))
  const list = document.createElement('ul')
  list.className = 'hx-issues'
  for (const x of issues) {
    const li = document.createElement('li')
    li.dataset.severity = x.severity
    const what = document.createElement('p')
    what.innerHTML = '<b></b> '
    what.querySelector('b')!.textContent = x.item.label
    what.append(x.message)
    li.append(what)
    if (x.fix) {
      const fix = document.createElement('p')
      fix.className = 'hx-fix'
      fix.textContent = x.fix
      li.append(fix)
    }
    list.append(li)
  }
  slot.replaceChildren(head, rows, list)
}
