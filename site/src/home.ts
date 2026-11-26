// The home page: the download buttons, the hero loop, the live canvas, the problem sections' clips and the harness scan.
import './site.css'
import type { DemoData } from './demo'
import { mountClips, mountHarness } from './clips'
import { wireDownloads } from './download'
import { Stage } from './stage'
import { mountLoop } from './loop'
import { mountFilm } from './film'

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

// The live canvas: it loads once the page is idle on a wide screen, zoomed so the flow fills it; on a phone only when asked, full screen.
const root = document.querySelector<HTMLElement>('[data-stage]')!
const narrow = matchMedia('(max-width: 760px)')
const stage = new Stage(root, { src: './canvas.html?hero', wheel: 'page', tabbable: false, fill: true })
if (!narrow.matches) stage.loadWhenIdle()

root.querySelector('[data-play]')?.addEventListener('click', async e => {
  const button = e.currentTarget as HTMLButtonElement
  button.disabled = true
  try {
    const tour = (await demo()).tours.find(t => t.id === button.dataset.play)
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
if (harness) {
  const io = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting) return
    io.disconnect()
    try {
      mountHarness(harness, await demo())
    } catch {
      harness.querySelector('p')!.textContent = 'The scan of the demo project could not be loaded. Reload the page to try again.'
    }
  }, { rootMargin: '400px' })
  io.observe(harness)
}
