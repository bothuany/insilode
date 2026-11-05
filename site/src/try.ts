// The Try page: the canvas with three stories a guide walks (two tours of the demo's flows and the canvas's own review of an agent's
// change), and the Agents dock with the status island.
import './site.css'
import { allowWaiting, mountAgents, setAvatar } from './agents'
import { mountAgentsPage } from './agentsPage'
import type { DemoData } from './demo'
import { wireDownloads } from './download'
import { Stage } from './stage'

wireDownloads()

const data: Promise<DemoData> = fetch('../data/demo.json').then(r => r.json())
const decision = document.querySelector<HTMLElement>('[data-decision]')!
const stage = new Stage(document.querySelector<HTMLElement>('[data-stage]')!, {
  src: '../canvas.html',
  wheel: 'canvas',
  tabbable: true,
  onDecided: what => {
    decision.textContent = what === 'keep' ? 'Kept. In the app the change stays in your code, and the cards go back to plain.' : 'Undone. In the app the agent’s edit is reverted in your files; here the demo goes back to the code before it.'
  },
})

type Story = 'order' | 'changes' | 'invoice'
const LABELS: Record<Exclude<Story, 'changes'>, string> = { order: 'OrderController.place', invoice: 'OrderController.invoice' }
const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-story]')]
let current: Story | undefined
let mode: 'plain' | 'changed' | undefined

async function play(story: Story) {
  current = story
  stage.root.classList.add('is-touring')
  buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.story === story)))
  if (story === 'changes') {
    decision.textContent = 'The review steps through each changed card. Keep or Undo is on every card.'
    mode = 'changed'
    await stage.reload('../canvas.html?t=changes&mode=changed')
    if (current === story) await stage.review()
    return
  }
  decision.textContent = 'Use the arrows in the tour bar, or press the arrow keys. Drag to move around; scroll or pinch to zoom.'
  // The tours play on the project as committed: after the change story, the canvas starts again without the change.
  if (mode !== 'plain') {
    mode = 'plain'
    await stage.reload('../canvas.html')
  }
  const tour = (await data).tours.find(t => t.id === story)
  if (tour && current === story) await stage.play(tour, LABELS[story])
}

buttons.forEach(b => b.addEventListener('click', () => play(b.dataset.story as Story)))
// A link to a story (#changes from the home page) plays it once the page has loaded; otherwise the canvas loads when the page is
// idle and waits on the order flow, so its code editor never competes with the page's own first paint.
const fromHash = location.hash.slice(1)
const linked = fromHash === 'changes' || fromHash === 'invoice' || fromHash === 'order' ? fromHash : undefined
if (linked) {
  if (document.readyState === 'complete') play(linked)
  else window.addEventListener('load', () => play(linked), { once: true })
} else {
  mode = 'plain'
  stage.loadWhenIdle()
}
document.querySelector('[data-play-story]')?.addEventListener('click', () => {
  const pressed = buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.story as Story | undefined
  play(pressed ?? 'order')
})

const dock = document.querySelector<HTMLIFrameElement>('iframe.dock')!
const island = document.querySelector<HTMLIFrameElement>('iframe.island')!
const agentsNote = document.querySelector<HTMLElement>('[data-agents-note]')!
data.then(d => mountAgents(dock, island, d, text => (agentsNote.textContent = text)))
const pickedAvatar = () => (document.querySelector<HTMLInputElement>('input[name="avatar"]:checked')?.value === 'pixel' ? 'pixel' : 'gyro')
let redrawPage = () => {}
data.then(d => {
  redrawPage = mountAgentsPage(document.querySelector<HTMLIFrameElement>('iframe.agents-page')!, d, pickedAvatar) as () => void
})
const allow = document.querySelector<HTMLButtonElement>('[data-allow]')!
allow.addEventListener('click', () => {
  if (allowWaiting()) {
    allow.disabled = true
    allow.textContent = 'Allowed'
  }
})
document.querySelectorAll<HTMLInputElement>('input[name="avatar"]').forEach(r => r.addEventListener('change', () => r.checked && (setAvatar(r.value === 'pixel' ? 'pixel' : 'gyro'), redrawPage())))
