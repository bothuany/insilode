// The centre of the home page: the real canvas, pinned on a wide screen while the visitor scrolls a tall track past it. Each stretch
// of the track is one step of the POST /orders tour, and the canvas's own tour player goes to it (its keys 1 to 9 go to a step), so
// scrolling walks the request card by card. The list beside the canvas is the tour's own step titles; a click on one scrolls to it.
// On a narrow screen the track is not pinned and the list is not shown: the canvas keeps its buttons and its own tour bar.
import type { Tour } from '../../protocol/flow'
import type { Stage } from './stage'

type Playable = Tour & { entry: string }

export function mountJourney(track: HTMLElement, list: HTMLOListElement, stage: Stage, load: () => Promise<Playable | undefined>, label: string) {
  const wide = matchMedia('(min-width: 1100px)')
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  const pin = track.querySelector<HTMLElement>('.journey-pin')!
  let tour: Playable | undefined
  let steps: HTMLLIElement[] = []
  let current = -1
  let started: Promise<void> | undefined
  /** The visitor took the canvas over (a click or a key in it, or the Play button): the scroll stops steering it. */
  let manual = false

  const draw = (t: Playable) => {
    track.style.setProperty('--steps', String(t.steps.length))
    steps = t.steps.map((s, i) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      const n = document.createElement('span')
      n.className = 'n'
      n.textContent = String(i + 1)
      const title = document.createElement('span')
      title.textContent = s.title
      b.append(n, title)
      b.addEventListener('click', () => scrollToStep(i))
      li.append(b)
      return li
    })
    list.replaceChildren(...steps)
  }

  /** How far the pinned part of the track has scrolled, 0 to 1; null when the track is not where it pins. */
  const progress = () => {
    const r = track.getBoundingClientRect()
    const span = track.offsetHeight - pin.offsetHeight
    if (span <= 0 || r.bottom < 0 || r.top > innerHeight) return null
    const top = parseFloat(getComputedStyle(pin).top) || 0
    return Math.min(1, Math.max(0, (top - r.top) / span))
  }

  const scrollToStep = (i: number) => {
    manual = false
    const span = track.offsetHeight - pin.offsetHeight
    const top = parseFloat(getComputedStyle(pin).top) || 0
    // The middle of the step's stretch, so a small scroll either way stays on it.
    const y = scrollY + track.getBoundingClientRect().top - top + ((i + 0.5) / steps.length) * span
    scrollTo({ top: y, behavior: still.matches ? 'auto' : 'smooth' })
  }

  const mark = (i: number) => {
    steps.forEach((li, k) => {
      li.classList.toggle('is-past', k < i)
      li.classList.toggle('is-now', k === i)
      li.querySelector('button')?.setAttribute('aria-current', k === i ? 'step' : 'false')
    })
    list.style.setProperty('--walked', String(steps.length > 1 ? i / (steps.length - 1) : 0))
  }

  /** Sends a key to the canvas's tour player, as if it were pressed on the canvas. */
  const press = (key: string) => {
    const w = stage.window as (Window & typeof globalThis) | null
    w?.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }
  const playing = () => !!stage.window?.document.querySelector('.tour')

  const go = async (i: number) => {
    // While the visitor drives the canvas the list stays where the canvas is, not where the scroll is.
    if (i === current || !tour || manual) return
    current = i
    mark(i)
    // The tour starts when the track first pins; if the visitor closed it since, the next step starts it again.
    if (!started || !playing()) {
      started = stage.play(tour, label).then(() => watch(stage.window))
      await started
      // The player draws its bar a moment after the message.
      for (let t = 0; t < 40 && !playing(); t++) await new Promise(r => setTimeout(r, 50))
    } else await started
    if (current === i && !manual) press(String(i + 1))
  }

  let queued = false
  const onScroll = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (!wide.matches || !steps.length) return
      const p = progress()
      if (p === null) return
      // Nothing happens until the canvas is in its pinned place: the track's top has reached the pin's top.
      const r = track.getBoundingClientRect()
      if (r.top > (parseFloat(getComputedStyle(pin).top) || 0) + 1) return
      go(Math.min(steps.length - 1, Math.floor(p * steps.length)))
    })
  }

  // A click or a key of the visitor's on the canvas, or the Play button, hands the tour to them until they pick a step from the
  // list. The keys this file sends are not the visitor's (they are untrusted events), so they never count.
  const takeOver = () => (manual = true)
  track.querySelector('[data-play]')?.addEventListener('click', takeOver)
  let watched: Window | null = null
  const watch = (w: Window | null) => {
    if (!w || w === watched) return
    watched = w
    w.addEventListener('pointerdown', takeOver, true)
    w.addEventListener('keydown', e => e.isTrusted && takeOver(), true)
  }

  load().then(t => {
    if (!t) return
    tour = t
    draw(t)
    addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  })
}
