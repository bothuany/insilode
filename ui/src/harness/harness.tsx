// The harness flow diagram's entry (protocol/harness.ts): an agent turn's lifecycle, left to right, with every harness piece
// (instructions, rules, skills, hooks, permissions, ...) under the step where it acts. The host panel computes the model;
// this page draws it and asks again when the mode, the agent, the event or the session changes.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './harness.css'
import type { HarnessAgent, HarnessCanvasToHost, HarnessFlowMode, HarnessFlowModel, HarnessFlowRequest, HostToHarnessCanvas, PreviewEvent } from '../../../protocol/harness'
import { sampleModel } from './fixture'
import { layout } from './layout'
import { nodeTypes } from './nodes'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

// Without VS Code (a plain browser) a fixture answers in the host's place, so the page can be looked at.
const vscode = typeof acquireVsCodeApi === 'undefined' ? undefined : acquireVsCodeApi()
function post(msg: HarnessCanvasToHost): void {
  if (vscode) {
    vscode.postMessage(msg)
    return
  }
  if (msg.type === 'ready' || msg.type === 'request') {
    const request: HarnessFlowRequest = msg.type === 'ready' ? { mode: 'static' } : msg.request
    setTimeout(() => window.postMessage({ type: 'model', request, model: sampleModel(request) } satisfies HostToHarnessCanvas, '*'), 80)
  }
}

const AGENTS: HarnessAgent[] = ['Claude', 'Codex', 'Cursor']
const MODES: { id: HarnessFlowMode; label: string }[] = [{ id: 'static', label: 'Static' }, { id: 'preview', label: 'Preview' }, { id: 'replay', label: 'Replay' }]
const TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Task']
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read'])
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** What the second field of the preview form is for, given the tool. */
function targetKind(tool: string): 'command' | 'file' | 'url' | 'none' {
  if (tool === 'Bash') return 'command'
  if (FILE_TOOLS.has(tool)) return 'file'
  if (tool === 'WebFetch') return 'url'
  return 'none'
}

function buildEvent(tool: string, target: string): PreviewEvent | undefined {
  const t = tool.trim()
  if (!t) return undefined
  const v = target.trim()
  switch (targetKind(t)) {
    case 'command': return { tool: t, command: v }
    case 'file': return { tool: t, file: v }
    case 'url': return { tool: t, input: v ? { url: v } : undefined }
    default: return { tool: t }
  }
}

/** Fits the view again when the set of cards changes (a new agent filter, a refresh), not on every highlight. */
function FitOnChange({ signature }: { signature: string }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.08, duration: reducedMotion() ? 0 : 250 }))
    return () => cancelAnimationFrame(id)
  }, [signature, fitView])
  return null
}

function Legend() {
  return (
    <span className="hs-legend" aria-label="Legend">
      <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--fl-signal)" strokeWidth="3" /></svg>solid: seen in the session's records</span>
      <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--fl-signal)" strokeWidth="3" strokeDasharray="6 4" /></svg>dashed: predicted from rules</span>
    </span>
  )
}

function App() {
  const [mode, setMode] = useState<HarnessFlowMode>('static')
  const [agent, setAgent] = useState<HarnessAgent | ''>('')
  const [tool, setTool] = useState('Bash')
  const [target, setTarget] = useState('')
  const [event, setEvent] = useState<PreviewEvent | undefined>()
  const [session, setSession] = useState('')
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [model, setModel] = useState<HarnessFlowModel | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  // Messages come in through one listener; it reads the current choices from here.
  const live = useRef({ mode, session })
  live.current = { mode, session }

  const ask = useCallback((over: Partial<{ mode: HarnessFlowMode; agent: HarnessAgent | ''; event: PreviewEvent | undefined; session: string }>) => {
    const m = over.mode ?? mode
    const a = 'agent' in over ? over.agent : agent
    const req: HarnessFlowRequest = { mode: m }
    if (a) req.agent = a
    if (m === 'preview') {
      const ev = 'event' in over ? over.event : event
      if (ev) req.event = ev
    }
    if (m === 'replay') {
      const s = 'session' in over ? over.session : session
      if (s) req.session = s
    }
    setLoading(true)
    setError(undefined)
    post({ type: 'request', request: req })
  }, [mode, agent, event, session])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as HostToHarnessCanvas | undefined
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'error') {
        setLoading(false)
        setError(msg.message)
      } else if (msg.type === 'model') {
        // An answer to a mode we already left would draw the wrong overlay.
        if (msg.request.mode !== live.current.mode) return
        setLoading(false)
        setError(undefined)
        setModel(msg.model)
        if (msg.request.mode === 'replay') {
          if (!live.current.session && msg.model.sessions?.length) {
            const first = msg.model.sessions[0].id
            setSession(first)
            live.current.session = first
            post({ type: 'request', request: { ...msg.request, session: first } })
            setLoading(true)
          } else {
            setStepIdx(i => Math.min(i, Math.max(0, (msg.model.steps?.length ?? 1) - 1)))
          }
        }
      }
    }
    window.addEventListener('message', onMessage)
    post({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const steps = model?.steps
  useEffect(() => {
    if (!playing) return
    if (!steps || stepIdx >= steps.length - 1) {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setStepIdx(i => i + 1), 1400)
    return () => clearTimeout(t)
  }, [playing, stepIdx, steps])

  const onOpen = useCallback((itemId: string) => post({ type: 'open', itemId }), [])

  const items = useMemo(() => (model?.items ?? []).filter(i => !agent || i.agents.includes(agent)), [model, agent])
  const hits = mode === 'preview' ? model?.hits : mode === 'replay' ? steps?.[stepIdx]?.hits : undefined
  const laid = useMemo(() => layout(items, hits, model?.mode, onOpen), [items, hits, model?.mode, onOpen])
  const signature = items.map(i => i.id).join('|')
  const shownHits = hits?.filter(h => items.some(i => i.id === h.itemId)) ?? []

  const switchMode = (m: HarnessFlowMode) => {
    if (m === mode) return
    setMode(m)
    setPlaying(false)
    setStepIdx(0)
    live.current.mode = m
    ask({ mode: m })
  }
  const changeAgent = (a: HarnessAgent | '') => {
    setAgent(a)
    setSession('')
    live.current.session = ''
    ask({ agent: a, session: '' })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const ev = buildEvent(tool, target)
    if (!ev) return
    setEvent(ev)
    ask({ event: ev })
  }
  const pickSession = (id: string) => {
    setSession(id)
    live.current.session = id
    setStepIdx(0)
    setPlaying(false)
    ask({ session: id })
  }

  const kind = targetKind(tool.trim())
  const step = steps?.[stepIdx]
  const sessions = (model?.sessions ?? []).filter(s => !agent || s.agent === agent)
  const empty = !loading && !error && (!model || items.length === 0)

  return (
    <div className="hs-app">
      <div className="hs-bar" role="toolbar" aria-label="Harness flow">
        <div className="hs-seg" role="group" aria-label="Mode">
          {MODES.map(m => <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => switchMode(m.id)}>{m.label}</button>)}
        </div>
        <label className="hs-field">Agent
          <select value={agent} onChange={e => changeAgent(e.target.value as HarnessAgent | '')} aria-label="Agent filter">
            <option value="">All</option>
            {AGENTS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>

        {mode === 'preview' && (
          <form className="hs-bar" style={{ padding: 0, border: 0, background: 'none' }} onSubmit={submit} aria-label="Preview an event">
            <label className="hs-field">Tool
              <input className="tool" list="hs-tools" value={tool} onChange={e => setTool(e.target.value)} placeholder="Bash or mcp__server__tool" aria-label="Tool name" />
              <datalist id="hs-tools">{TOOLS.map(t => <option key={t} value={t} />)}</datalist>
            </label>
            {kind !== 'none' && (
              <label className="hs-field">{kind === 'command' ? 'Command' : kind === 'file' ? 'File' : 'URL'}
                <input className="mono" value={target} onChange={e => setTarget(e.target.value)} placeholder={kind === 'command' ? 'npm test' : kind === 'file' ? 'src/app.ts' : 'https://'} aria-label={kind === 'command' ? 'Command' : kind === 'file' ? 'File' : 'URL'} />
              </label>
            )}
            <button className="hs-btn" type="submit" disabled={!tool.trim()}>Show path</button>
          </form>
        )}

        {mode === 'replay' && (
          <>
            <label className="hs-field">Session
              <select value={session} onChange={e => pickSession(e.target.value)} aria-label="Session" disabled={sessions.length === 0}>
                {sessions.length === 0 && <option value="">No sessions</option>}
                {sessions.map(s => <option key={s.id} value={s.id}>{s.agent}: {s.title}</option>)}
              </select>
            </label>
            {steps && steps.length > 0 && (
              <>
                <button className="hs-icon" type="button" aria-label="Previous step" disabled={stepIdx <= 0} onClick={() => { setPlaying(false); setStepIdx(i => Math.max(0, i - 1)) }}>&lsaquo;</button>
                <button className="hs-icon" type="button" aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} onClick={() => { if (!playing && stepIdx >= steps.length - 1) setStepIdx(0); setPlaying(p => !p) }}>{playing ? '❚❚' : '▶'}</button>
                <button className="hs-icon" type="button" aria-label="Next step" disabled={stepIdx >= steps.length - 1} onClick={() => { setPlaying(false); setStepIdx(i => Math.min(steps.length - 1, i + 1)) }}>&rsaquo;</button>
                <input className="hs-slider" type="range" min={0} max={steps.length - 1} value={stepIdx} onChange={e => { setPlaying(false); setStepIdx(Number(e.target.value)) }} aria-label="Step" aria-valuetext={step?.label} />
                <span className="hs-step" aria-live="polite">{stepIdx + 1}/{steps.length} {step?.label}{step?.subagent ? ` (${step.subagent})` : ''}</span>
              </>
            )}
            <span className="grow" />
            <Legend />
          </>
        )}
      </div>

      <div className="hs-stage">
        <ReactFlow
          nodes={laid.nodes}
          edges={laid.edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          minZoom={0.15}
          maxZoom={1.6}
          fitView
          fitViewOptions={{ padding: 0.08 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable ariaLabel="Overview of the turn" />
          <FitOnChange signature={signature} />
        </ReactFlow>
        {loading && <div className="hs-state" role="status">Loading the harness...</div>}
        {error && <div className="hs-state error" role="alert">{error}</div>}
        {empty && <div className="hs-state" role="status">No harness pieces found for this workspace{agent ? ` and ${agent}` : ''}.</div>}
        {mode === 'preview' && !loading && !error && model && (event ? shownHits.length === 0 : true) && (
          <div className="hs-note" role="status">{event ? 'No harness piece is on this event\'s path.' : 'Pick a tool and press Show path to light up what acts on it.'}</div>
        )}
        {mode === 'replay' && !loading && !error && model && sessions.length > 0 && steps && steps.length === 0 && <div className="hs-note" role="status">This session has no recorded steps.</div>}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App /></ReactFlowProvider>)
