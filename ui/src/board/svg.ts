// The board as a standalone SVG (and from it a PNG): drawn from the same layout and routes as the canvas, with plain
// shapes and text only (no foreignObject, no CSS variables), so any viewer renders it. Every text is escaped.
import { cardinalityAt, orderBadge, routeEdge, veeOf } from './route'
import { CARD_PAD, DETAIL_H, detailOf, GROUP_HEAD, HEADER_H, MARK_SIZE, ROW_H, type Layout, type VNode } from './model'
import { edgeText, KIND_COLOR, lineStyle, STEREOTYPE } from './protocol'
import { buildSequence, sequenceShapes, type Shape, type Tone } from './sequence'
import type { BoardSpec } from '../../../board-canvas/spec'

export interface Palette {
  canvas: string
  card: string
  line: string
  text: string
  muted: string
  signal: string
  add: string
  del: string
  warn: string
  groupFill: string
}

export const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const FONT = `font-family="'Segoe UI', system-ui, sans-serif"`
const MONO = `font-family="Consolas, 'JetBrains Mono', Menlo, monospace"`

export function toSvg(layout: Layout, direction: 'LR' | 'TB', p: Palette, title?: string): string {
  const margin = 48
  let maxX = 0
  let maxY = 0
  for (const n of layout.nodes) {
    maxX = Math.max(maxX, n.box.x + n.box.w)
    maxY = Math.max(maxY, n.box.y + n.box.h)
  }
  for (const g of layout.groups) {
    maxX = Math.max(maxX, g.box.x + g.box.w)
    maxY = Math.max(maxY, g.box.y + g.box.h)
  }
  const w = Math.ceil(maxX + margin * 2)
  const h = Math.ceil(maxY + margin * 2 + (title ? 28 : 0))
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`, `<rect width="${w}" height="${h}" fill="${p.canvas}"/>`]
  if (title) {
    out.push(`<text x="${margin}" y="30" ${FONT} font-size="16" font-weight="600" fill="${p.text}">${xml(title)}</text>`)
  }
  out.push(`<g transform="translate(${margin} ${margin + (title ? 28 : 0)})">`)
  for (const g of [...layout.groups].sort((a, b) => a.depth - b.depth)) {
    out.push(`<rect x="${g.box.x}" y="${g.box.y}" width="${g.box.w}" height="${g.box.h}" rx="10" fill="${p.groupFill}" stroke="${p.line}"/>`)
    out.push(`<text x="${g.box.x + 12}" y="${g.box.y + GROUP_HEAD - 9}" ${FONT} font-size="12" font-weight="600" fill="${p.muted}">${xml(clip(g.group.label, 48))} (${g.count})</text>`)
  }
  const byId = new Map(layout.nodes.map(n => [n.id, n]))
  const pairs = new Map<string, number>()
  const total = new Map<string, number>()
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const e of layout.edges) total.set(pairKey(e.from, e.to), (total.get(pairKey(e.from, e.to)) ?? 0) + 1)
  const color = (c: 'text' | 'muted' | 'signal' | 'add' | 'del' | 'warn') => p[c]
  for (const e of layout.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    const k = pairKey(e.from, e.to)
    const i = pairs.get(k) ?? 0
    pairs.set(k, i + 1)
    const st = lineStyle(e)
    const r = routeEdge({ from, to, edge: e }, direction, i, total.get(k) ?? 1)
    const c = color(st.color)
    out.push(`<path d="${r.d}" fill="none" stroke="${c}" stroke-width="1.4"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`)
    if (r.head) {
      const open = e.async && r.head.kind === 'fill'
      out.push(`<path d="${open ? veeOf(r) : r.head.d}" fill="${!open && r.head.kind === 'fill' ? c : r.head.kind === 'tri' ? p.canvas : 'none'}" stroke="${c}" stroke-width="1.4"/>`)
    }
    if (e.order !== undefined) {
      const b = orderBadge(r)
      out.push(`<circle cx="${b.x}" cy="${b.y}" r="8" fill="${p.canvas}" stroke="${c}"/>`, `<text x="${b.x}" y="${b.y + 3.5}" text-anchor="middle" ${FONT} font-size="10" font-weight="600" fill="${p.text}">${e.order}</text>`)
    }
    const label = edgeText(e)
    if (label) {
      out.push(`<text x="${r.mid.x}" y="${r.mid.y - 4}" text-anchor="middle" ${FONT} font-size="10" fill="${p.muted}" stroke="${p.canvas}" stroke-width="3" paint-order="stroke">${xml(clip(label, 40))}</text>`)
    }
    if (e.fromCard || e.toCard) {
      const c2 = cardinalityAt(r)
      if (e.fromCard) out.push(`<text x="${c2.from.x}" y="${c2.from.y + 3}" text-anchor="middle" ${FONT} font-size="10" fill="${p.muted}">${xml(e.fromCard)}</text>`)
      if (e.toCard) out.push(`<text x="${c2.to.x}" y="${c2.to.y + 3}" text-anchor="middle" ${FONT} font-size="10" fill="${p.muted}">${xml(e.toCard)}</text>`)
    }
  }
  for (const n of layout.nodes) out.push(nodeSvg(n, p))
  out.push('</g></svg>')
  return out.join('\n')
}

function nodeSvg(v: VNode, p: Palette): string {
  const { x, y, w, h } = v.box
  const out: string[] = []
  if (v.group) {
    out.push(`<rect x="${x + 4}" y="${y + 4}" width="${w}" height="${h}" rx="8" fill="${p.card}" stroke="${p.line}"/>`)
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${p.card}" stroke="${p.line}"/>`)
    out.push(`<text x="${x + 12}" y="${y + 24}" ${FONT} font-size="13" font-weight="600" fill="${p.text}">${xml(clip(v.group.label, 28))}</text>`)
    out.push(`<text x="${x + 12}" y="${y + 44}" ${FONT} font-size="11" fill="${p.muted}">${v.count} ${v.count === 1 ? 'type' : 'types'}</text>`)
    return out.join('\n')
  }
  const n = v.node!
  const c = KIND_COLOR[n.kind ?? 'class']
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${p.card}" stroke="${p.line}"/>`)
  out.push(`<path d="M${x} ${y + 7} a7 7 0 0 1 7 -7 h${w - 14} a7 7 0 0 1 7 7 v3 h${-w} z" fill="${c}"/>`)
  const st = n.kind ? STEREOTYPE[n.kind] : undefined
  if (st) out.push(`<text x="${x + 11}" y="${y + 21}" ${FONT} font-size="10" fill="${p.muted}">«${xml(st)}»</text>`)
  out.push(`<text x="${x + 11}" y="${y + (st ? 37 : 28)}" ${FONT} font-size="13" font-weight="600" fill="${p.text}">${xml(clip(n.label, Math.floor((w - 20) / 7.4)))}</text>`)
  if (detailOf(n)) out.push(`<text x="${x + 11}" y="${y + HEADER_H + 9}" ${FONT} font-size="10.5" fill="${p.muted}">${xml(clip(detailOf(n), Math.floor((w - 20) / 6)))}</text>`)
  if (v.rows.length) {
    const top = y + HEADER_H + (detailOf(n) ? DETAIL_H : 0)
    out.push(`<line x1="${x}" y1="${top}" x2="${x + w}" y2="${top}" stroke="${p.line}"/>`)
    v.rows.forEach((m, i) => {
      const cy = top + CARD_PAD + i * ROW_H + ROW_H / 2 + 4
      out.push(`<text x="${x + 10}" y="${cy}" ${MONO} font-size="11" fill="${p.muted}">${xml(m.visibility ?? ' ')}</text>`)
      out.push(`<text x="${x + 24}" y="${cy}" ${MONO} font-size="11" fill="${m.ref ? p.signal : p.text}">${xml(clip(m.text, Math.floor((w - 34) / 6.7)))}</text>`)
    })
    if (v.more) out.push(`<text x="${x + 24}" y="${top + CARD_PAD + v.rows.length * ROW_H + ROW_H / 2 + 4}" ${FONT} font-size="10.5" fill="${p.muted}">+${v.more} more</text>`)
  }
  return out.join('\n')
}

/** A sequence board as a standalone SVG: the same shapes the canvas draws, with the palette's plain colours. */
export function sequenceSvg(spec: BoardSpec, p: Palette, title?: string): string {
  const layout = buildSequence(spec)
  const { shapes } = sequenceShapes(layout, spec)
  const margin = 24
  const head = title ? 28 : 0
  const w = layout.width + margin * 2
  const h = layout.height + margin * 2 + head
  const tone = (t: Tone | undefined) => (t === undefined ? 'none' : t === 'note' ? '#e6c15a' : p[t === 'canvas' ? 'canvas' : t === 'card' ? 'card' : t === 'line' ? 'line' : t])
  const attrs = (sh: Shape, fillDefault: string) => `fill="${sh.fill ? tone(sh.fill) : fillDefault}"${sh.fillOpacity !== undefined ? ` fill-opacity="${sh.fillOpacity}"` : ''} stroke="${sh.stroke ? tone(sh.stroke) : 'none'}"${sh.sw ? ` stroke-width="${sh.sw}"` : ''}${sh.dash ? ` stroke-dasharray="${sh.dash}"` : ''}`
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`, `<rect width="${w}" height="${h}" fill="${p.canvas}"/>`]
  if (title) out.push(`<text x="${margin}" y="22" ${FONT} font-size="16" font-weight="600" fill="${p.text}">${xml(title)}</text>`)
  out.push(`<g transform="translate(${margin} ${margin + head + layout.padTop})">`)
  for (const sh of shapes) {
    switch (sh.t) {
      case 'rect': out.push(`<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" rx="${sh.r ?? 0}" ${attrs(sh, 'none')}/>`); break
      case 'line': out.push(`<line x1="${sh.x}" y1="${sh.y}" x2="${sh.x2}" y2="${sh.y2}" ${attrs(sh, 'none')}/>`); break
      case 'path': out.push(`<path d="${sh.d}" ${attrs(sh, 'none')}/>`); break
      case 'circle': out.push(`<circle cx="${sh.x}" cy="${sh.y}" r="${sh.r}" ${attrs(sh, 'none')}/>`); break
      case 'text': out.push(`<text x="${sh.x}" y="${sh.y}" text-anchor="${sh.anchor ?? 'start'}" ${FONT} font-size="${sh.size}"${sh.bold ? ' font-weight="600"' : ''} fill="${sh.fill ? tone(sh.fill) : p.text}">${xml(sh.text ?? '')}</text>`); break
    }
  }
  out.push('</g></svg>')
  return out.join('\n')
}
