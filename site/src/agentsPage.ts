// The Try page's Agents page: the app's full-editor page behind the title bar's Agents button, in an iframe, told about five agents
// on the demo project. Like the dock beside it this is a fixed moment written here; the page itself is the app's own code
// (pages/agents.html). The shapes follow flow-agent's agentsData.ts (AgentsPageData, AgentsPageTail, AgentsPageTermFailed); they are written out here
// because the site may not import that file (it reaches `vscode`). The same goes for AgentsPageChatIndex (the sidebar's earlier sessions, here with one
// session that another program runs: ChatIndexSession.live, liveSessions.ts).
import type { AvatarKind } from '../../editor/extensions/flow-agent/src/desktopModel'
import type { DemoData } from './demo'

const MIN = 60_000
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function rows(data: DemoData, now: number) {
  const base = { explain: false, skeletonOn: false, skeletonAvailable: false, acceptsInput: true }
  const impact = data.agentImpact && { files: data.agentImpact.files, more: data.agentImpact.more, flows: data.agentImpact.flows.map(f => ({ label: f.label, via: f.via })), tables: data.agentImpact.tables }
  return [
    {
      ...base,
      id: 'billing',
      name: 'Codex',
      cli: 'codex',
      state: 'blocked',
      unread: true,
      since: now - 2 * MIN,
      attention: 'approval',
      need: { kind: 'approval', source: 'permission', text: 'Run pytest billing-service/tests', at: now - 40_000 },
      prompt: 'Make the invoice total include the discount.',
      todos: [
        { text: 'Read InvoiceService.issue', status: 'completed' },
        { text: 'Apply the discount to the total', status: 'completed' },
        { text: 'Run the billing tests', status: 'in_progress' },
      ],
      done: 2,
      current: 'Run the billing tests',
      usage: { used: 61_000, size: 200_000, percent: 31, model: 'gpt-5.5' },
    },
    {
      ...base,
      id: 'shipping',
      name: 'Claude Code',
      cli: 'claude',
      state: 'working',
      unread: false,
      since: now - 7 * MIN,
      activity: 'Editing ShipmentService.java',
      prompt: 'Schedule express shipments for orders over 100 euros.',
      todos: [
        { text: 'Read OrderEvents.onOrderPlaced', status: 'completed' },
        { text: 'Add an express option to Shipment', status: 'in_progress' },
        { text: 'Write a test for the threshold', status: 'pending' },
      ],
      done: 1,
      current: 'Add an express option to Shipment',
      usage: { used: 23_000, size: 200_000, percent: 12, model: 'claude-sonnet-5-5' },
      cost: { session: { tokens: { ...NO_TOKENS, input: 9_000, output: 4_000, cacheRead: 10_000 }, usd: 0.41 }, scope: 'main agent (subagents not included)', usdSource: 'Claude Code status line' },
    },
    {
      ...base,
      id: 'orders',
      name: 'Claude Code',
      cli: 'claude',
      state: 'done',
      unread: true,
      since: now - 4 * MIN,
      attention: 'done',
      prompt: 'Add discount codes to orders: a code on the order cuts its total before it is saved and invoiced.',
      todos: [
        { text: 'Add discount_code to Order', status: 'completed' },
        { text: 'Apply it in OrderService.java', status: 'completed' },
      ],
      done: 2,
      usage: { used: 84_000, size: 200_000, percent: 42, model: 'claude-opus-5-5' },
      cost: { session: { tokens: { ...NO_TOKENS, input: 31_000, output: 12_000, cacheRead: 41_000 }, usd: 1.87 }, prompt: { tokens: { ...NO_TOKENS, input: 31_000, output: 12_000, cacheRead: 41_000 }, usd: 1.87 }, scope: 'main agent (subagents not included)', usdSource: 'Claude Code status line' },
      impact,
      explain: true,
      pr: {
        number: 42,
        state: 'open',
        title: 'Discount codes on orders',
        url: 'https://github.com/harbor-goods/shop/pull/42',
        checks: 'pass',
        counts: { pass: 6, fail: 0, pending: 0 },
        failing: [],
        reviewDecision: 'REVIEW_REQUIRED',
        mergeable: 'MERGEABLE',
        headRefOid: '3f9a1c2',
        comments: [],
        reviews: [],
        author: 'harbor-dev',
      },
    },
    {
      ...base,
      id: 'search',
      name: 'Claude Code',
      cli: 'claude',
      state: 'idle',
      unread: false,
      since: now - 12 * MIN,
      prompt: 'Add a product search endpoint with paging.',
      todos: [],
      done: 0,
      usage: { used: 47_000, size: 200_000, percent: 24, model: 'claude-sonnet-5-5' },
      worktree: { branch: 'insilode/claude-7b21', base: 'main', ahead: 3, behind: 2, uncommitted: 1 },
      clash: [{ text: 'Codex edited InvoiceService.java too', same: false, files: ['billing-service/app/invoice.py'] }],
    },
    {
      ...base,
      id: 'old',
      name: 'Codex',
      cli: 'codex',
      state: 'ended',
      unread: false,
      since: now - 40 * MIN,
      prompt: 'Rename the customer table column.',
      todos: [],
      done: 0,
      acceptsInput: false,
    },
  ]
}

const TAILS: Record<string, { role: 'user' | 'assistant' | 'tool'; text: string }[]> = {
  billing: [
    { role: 'user', text: 'Make the invoice total include the discount.' },
    { role: 'tool', text: 'Read billing-service/app/invoice.py' },
    { role: 'tool', text: 'Edit billing-service/app/invoice.py' },
    { role: 'assistant', text: 'The discount is applied to the total. I will run the billing tests next.' },
  ],
  shipping: [
    { role: 'user', text: 'Schedule express shipments for orders over 100 euros.' },
    { role: 'tool', text: 'Read shipping-service/src/OrderEvents.java' },
    { role: 'assistant', text: 'Orders above the threshold need their own shipment option. Adding it now.' },
    { role: 'tool', text: 'Edit shipping-service/src/ShipmentService.java' },
  ],
  orders: [
    { role: 'user', text: 'Add discount codes to orders: a code on the order cuts its total before it is saved and invoiced.' },
    { role: 'tool', text: 'Edit orders-service/src/main/java/com/harborgoods/orders/OrderService.java' },
    { role: 'assistant', text: 'Orders now take a discount code; the total is cut before the order is saved, so the invoice follows.' },
  ],
  search: [
    { role: 'user', text: 'Add a product search endpoint with paging.' },
    { role: 'assistant', text: 'The endpoint is in and paged by 20. Three commits are on the branch.' },
  ],
}

// A session of the Claude desktop app on another project of this computer, waiting for its user: it shows in the list as running elsewhere and in the queue.
const EXTERNAL = '5b1e7a52-3c1d-4f0b-9c55-0e2f6a7d8b91'
TAILS[EXTERNAL] = [
  { role: 'user', text: 'Rewrite the quick start so it starts with the Try page.' },
  { role: 'tool', text: 'Edit docs/quick-start.md' },
  { role: 'assistant', text: 'The quick start now opens with the Try page. Shall I also move the install steps below it?' },
]
const chatIndex = (now: number) => ({
  type: 'chatIndex',
  projects: [
    { key: 'a1b2c3d4e5f6', name: 'shop', where: '~/shop', cwd: '/Users/dev/shop', own: true, sessions: [] },
    {
      key: 'b2c3d4e5f6a1',
      name: 'harbor-docs',
      where: '~/harbor-docs',
      cwd: '/Users/dev/harbor-docs',
      own: false,
      sessions: [
        { id: EXTERNAL, kind: 'claude', title: 'Docs quick start', modified: now - 20_000, live: { status: 'needs', source: 'Claude desktop', basis: 'live' } },
        { id: '6c2f8b63-4d2e-4a1c-8d66-1f3a7b8e9ca2', kind: 'claude', title: 'Changelog for 0.15', modified: now - 3 * 60 * MIN },
      ],
    },
  ],
})

export function mountAgentsPage(frame: HTMLIFrameElement, data: DemoData, avatar: () => AvatarKind) {
  let ready = false
  const send = (message: unknown) => frame.contentWindow?.postMessage(message, location.origin)
  const sendData = () =>
    ready &&
    send({
      type: 'data',
      now: Date.now(),
      avatar: avatar(),
      rows: rows(data, Date.now()),
      kept: [{ agent: 'Claude Code', branch: 'insilode/claude-3f9a', base: 'main', folder: 'shop-claude-3f9a' }],
      limits: {
        harness: 'claude',
        windows: [
          { label: '5h', usedPercent: 38, resetsAt: Date.now() + 2.5 * 60 * MIN },
          { label: 'wk', usedPercent: 17, resetsAt: Date.now() + 4 * 24 * 60 * MIN },
        ],
      },
      customs: ['gemini'],
    })
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return
    const m = e.data as { source?: string; message?: { type: string; id?: string; requestId?: string } }
    if (m?.source !== 'insilode-agents' || !m.message) return
    if (m.message.type === 'ready') {
      ready = true
      sendData()
      send(chatIndex(Date.now()))
    } else if (m.message.type === 'chatList') {
      send(chatIndex(Date.now()))
    } else if (m.message.type === 'tail' && m.message.id) {
      const entries = TAILS[m.message.id]
      const now = Date.now()
      send(entries ? { type: 'tail', id: m.message.id, entries: entries.map((x, i) => ({ ...x, at: now - (entries.length - i) * MIN })) } : { type: 'tail', id: m.message.id, entries: [], note: 'This agent has no transcript on this page.' })
    } else if (m.message.type === 'termOpen' && m.message.requestId) {
      // No terminal behind this page: a pane that asks to start or resume a session is told so, instead of waiting for one.
      send({ type: 'termFailed', requestId: m.message.requestId, message: 'Terminals run in the Insilode editor. This page only shows how the workspace works.' })
    }
  })
  setInterval(sendData, 5000)
  // The page may have loaded (and said `ready`) before the demo data arrived: then it is drawn now.
  if (frame.contentDocument?.readyState === 'complete') {
    ready = true
    sendData()
    send(chatIndex(Date.now()))
  }
  return sendData
}
