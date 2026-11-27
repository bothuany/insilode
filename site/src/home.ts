// The home page: the download buttons, the hero loop, the live canvas and its scroll-driven tour, the feature clips, the live Agents
// dock and status island, the harness scan, and the small motions around them.
import './site.css'
import './home.css'
import type { DemoData } from './demo'
import { allowWaiting, mountAgents } from './agents'
import { mountClips, mountHarness } from './clips'
import { wireDownloads } from './download'
import { Stage } from './stage'
import { mountLoop } from './loop'
import { mountFilm } from './film'
import { mountJourney } from './journey'

wireDownloads()
mountClips()
mountLoop(document.querySelector<HTMLVideoElement>('[data-loop]'))
mountFilm(document.querySelector<HTMLElement>('[data-film-open]'), document.querySelector<HTMLDialogElement>('[data-film]'))

let data: Promise<DemoData> | undefined
// A load that failed is not kept: the next click or scroll asks again.
const demo = () =>
  (data ??= fetch('./data/demo.json')
    .then(r => (r.ok ? (r.json() as Promise<DemoData>) : Promise.reject(new Error(`demo.json: ${r.status}`))))
    .catch(e => {
      data = undefined
      throw e
    }))

/** Runs `then` once, when `el` comes within `margin` of the screen. */
function near(el: Element | null, then: () => void, margin = '400px') {
  if (!el) return
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return
    io.disconnect()
    then()
  }, { rootMargin: margin })
  io.observe(el)
}

// The live canvas: it loads once the page is idle on a wide screen, zoomed so the flow fills it; on a phone only when asked, full screen.
const root = document.querySelector<HTMLElement>('[data-stage]')!
const narrow = matchMedia('(max-width: 760px)')
const stage = new Stage(root, { src: './canvas.html?hero', wheel: 'page', tabbable: false, fill: true })
if (!narrow.matches) stage.loadWhenIdle()

const orderTour = async () => (await demo()).tours.find(t => t.id === 'order')
mountJourney(document.querySelector<HTMLElement>('[data-track]')!, document.querySelector<HTMLOListElement>('[data-steps]')!, stage, () => orderTour().catch(() => undefined), 'OrderController.place')

root.querySelector('[data-play]')?.addEventListener('click', async e => {
  const button = e.currentTarget as HTMLButtonElement
  button.disabled = true
  try {
    const tour = await orderTour()
    if (tour) {
      // The tour bar takes the bottom of the canvas: the button steps aside while the tour plays.
      root.classList.add('is-touring')
      await stage.play(tour, 'OrderController.place')
      stage.setTabbable(true)
      // The tour bar has the keys (next, back, close): give it the focus, so a keyboard can drive the tour.
      stage.window?.focus()
    }
  } catch {
    root.classList.remove('is-touring')
    stage.note('The tour could not be loaded. Try again in a moment.')
  } finally {
    button.disabled = false
  }
})

const close = root.querySelector<HTMLButtonElement>('[data-close]')!
const explore = root.querySelector<HTMLButtonElement>('[data-explore]')!
function full(on: boolean) {
  root.classList.toggle('is-full', on)
  document.body.classList.toggle('is-locked', on)
  stage.setWheel(on ? 'canvas' : 'page')
  stage.setTabbable(on)
  if (on) {
    stage.load()
    close.focus()
  } else explore.focus()
}
explore.addEventListener('click', () => full(true))
close.addEventListener('click', () => full(false))
document.addEventListener('keydown', e => e.key === 'Escape' && root.classList.contains('is-full') && full(false))

// The harness scan is drawn from the demo data when its section comes near.
const harness = document.querySelector<HTMLElement>('[data-harness]')
near(harness, async () => {
  try {
    mountHarness(harness!, await demo())
  } catch {
    harness!.querySelector('p')!.textContent = 'The scan of the demo project could not be loaded. Reload the page to try again.'
  }
})

// The Agents dock and the status island: the app's own pages, told about three agents at work on the demo project (src/agents.ts).
// They load when their section comes near; while it is on screen the island hangs at the top of the window, as it does in the app.
const agents = document.querySelector<HTMLElement>('[data-agents]')
const dock = agents?.querySelector<HTMLIFrameElement>('iframe.dock')
const island = agents?.querySelector<HTMLIFrameElement>('iframe.island')
const note = agents?.querySelector<HTMLElement>('[data-agents-note]')
if (agents && dock && island && note) {
  near(agents, async () => {
    dock.src = dock.dataset.src!
    island.src = island.dataset.src!
    try {
      mountAgents(dock, island, await demo(), text => (note.textContent = text))
    } catch {
      note.textContent = 'The agents of the demo could not be loaded. Reload the page to try again.'
    }
  }, '600px')
  new IntersectionObserver(([e]) => island.classList.toggle('is-down', e.isIntersecting), { threshold: 0.12 }).observe(agents)
  const allow = agents.querySelector<HTMLButtonElement>('[data-allow]')!
  allow.addEventListener('click', () => {
    if (allowWaiting()) {
      allow.disabled = true
      allow.textContent = 'Allowed'
      note.textContent = 'Codex runs the billing tests, then finishes; watch the dock and the island.'
    }
  })
}

// The band of what VS Code does drifts sideways: its chips are doubled so the loop has no seam (the copy is hidden from readers).
const chips = document.querySelector('.marquee .chips')
chips?.append(
  ...[...chips.children].map(li => {
    const copy = li.cloneNode(true) as HTMLElement
    copy.setAttribute('aria-hidden', 'true')
    return copy
  }),
)

// The agent's terminal prints its lines one after another when it comes on screen; without this script it is simply all there.
const terminal = document.querySelector<HTMLElement>('[data-terminal]')
if (terminal && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  ;[...terminal.children].forEach((line, i) => (line as HTMLElement).style.setProperty('--i', String(i)))
  terminal.classList.add('is-armed')
  near(terminal, () => terminal.classList.add('is-playing'), '-15% 0px')
}

// The install commands copy with one click.
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button =>
  button.addEventListener('click', async () => {
    const text = button.parentElement?.querySelector('code')?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Select and copy'
    }
    setTimeout(() => (button.textContent = 'Copy'), 2000)
  }),
)

// A card lights up under the pointer, the way a card on the canvas lights when the trace reaches it.
document.querySelectorAll<HTMLElement>('.facts li, .tiles li').forEach(card =>
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect()
    card.style.setProperty('--mx', `${e.clientX - r.left}px`)
    card.style.setProperty('--my', `${e.clientY - r.top}px`)
  }),
)
