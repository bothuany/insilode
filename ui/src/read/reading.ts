// What the reading pane works out from the code it shows: where a method's first call is, which values a call passes to which
// parameters, and the border a call crosses into another service. Pure, so it runs under plain Node (ui/test/reading.test.mjs).
import type { EdgeKind, FlowNode } from '../types'

export interface Binding {
  param: string
  arg: string
}

/** The line a reading of this method starts on: its first call, else its first line. */
export function firstCall(node: FlowNode) {
  const lines = node.children.map(e => e.callLine).filter(l => l >= node.startLine)
  return lines.length ? Math.min(...lines) : node.startLine
}

/** The text between the bracket at `open` and the one that closes it, or null when it does not close on this text. */
function inside(text: string, open: number) {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/** Splits on the commas that are not inside brackets, quotes or generic arguments. */
function topLevel(list: string) {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{<'.includes(ch)) depth++
    else if (')]}>'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(from, i))
      from = i + 1
    }
  }
  out.push(list.slice(from))
  return out.map(s => s.trim()).filter(Boolean)
}

/** A parameter's name, from Java/C#/Kotlin (`final Order order`), Python and TypeScript (`body: dict = None`, `*args`). */
function paramName(p: string) {
  const plain = p
    .replace(/@[\w.]+(\([^)]*\))?\s*/g, '')
    .replace(/=.*$/, '')
    .trim()
  // `name: Type` (Python, TypeScript, Kotlin) names before the colon; `Type name` (Java, C#) names last. Either way, the last word.
  const colon = plain.indexOf(':')
  const words = (colon >= 0 ? plain.slice(0, colon) : plain).replace(/[*&?.]/g, ' ').trim().split(/\s+/)
  return words[words.length - 1] ?? ''
}

/**
 * The values a call passes and the parameters they land in: `billing.createInvoice(saved)` into `createInvoice(Order order)` gives
 * order ← saved. A guess from the text: nothing when the call or the signature cannot be read, or when their counts differ.
 */
export function bindings(callLine: string, callee: FlowNode): Binding[] {
  const member = callee.label.replace(/\s*▸\s*/g, '.').split('.').pop() ?? ''
  // Only a plain name can be looked for: a label that is a route or carries brackets names no call on the line (and would be regex syntax).
  if (!/^[A-Za-z_$][\w$]*$/.test(member) || !callee.code) return []
  const call = new RegExp(`(^|[^\\w$])${member.replace(/\$/g, '\\$')}\\s*\\(`)
  const at = callLine.search(call)
  if (at < 0) return []
  const args = inside(callLine, callLine.indexOf('(', at + 1))
  const sigAt = callee.code.search(call)
  if (args === null || sigAt < 0) return []
  const params = inside(callee.code, callee.code.indexOf('(', sigAt + 1))
  if (params === null) return []
  const rawParams = topLevel(params).map(p => p.replace(/@[\w.]+(\([^)]*\))?\s*/g, '').trim())
  const values = topLevel(args)
  // Pairing by position is only right when every argument is positional and every parameter a plain name: named or keyword
  // arguments, spreads, **kwargs and destructured parameters would pair the wrong way, so they show nothing.
  if (values.some(v => /^(\*|\.\.\.)/.test(v) || /^[A-Za-z_]\w*\s*(=(?!=)|:(?!:))/.test(v))) return []
  if (rawParams.some(p => /^(\*|\.\.\.|\{|\[)/.test(p))) return []
  const names = rawParams.map(paramName).filter(n => n && n !== 'self' && n !== 'cls' && n !== 'this')
  if (!values.length || names.length !== values.length || names.some(n => !/^[A-Za-z_$][\w$]*$/.test(n))) return []
  return names.map((param, i) => ({ param, arg: values[i] }))
}

const LANGS: Record<string, string> = { py: 'Python', java: 'Java', kt: 'Kotlin', cs: 'C#', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript', go: 'Go', rb: 'Ruby', php: 'PHP', rs: 'Rust' }
const language = (file: string | null) => LANGS[file?.split('.').pop()?.toLowerCase() ?? ''] ?? ''
/** The folder a service lives in: the one above `src`, `app` or `lib`, else the file's top folder. A guess from the path. */
export function serviceOf(file: string | null) {
  const parts = (file ?? '').split(/[\\/]/).filter(Boolean)
  const i = parts.findIndex(p => p === 'src' || p === 'app' || p === 'lib')
  return i > 0 ? parts[i - 1] : (parts.length > 1 ? parts[parts.length - 2] : '')
}

/** The border a call crosses, in words: an HTTP request or a message into another service, or a step into another language. */
export function crossing(kind: EdgeKind, from: FlowNode, to: FlowNode) {
  const svc = serviceOf(to.file)
  const lang = language(to.file)
  const where = [svc !== serviceOf(from.file) ? svc : '', lang !== language(from.file) ? lang : ''].filter(Boolean).join(' · ')
  if (kind === 'http') return `HTTP ${to.sub || ''}${where ? `  →  ${where}` : ''}`.trim()
  if (kind === 'message') return `Message ${to.sub.replace(/^MSG\s+/, '') || ''}${where ? `  →  ${where}` : ''}`.trim()
  return null
}
