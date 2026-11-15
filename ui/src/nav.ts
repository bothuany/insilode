// One way to move on every canvas (the flow, the boards, the harness flow): the wheel and two fingers on a trackpad move the view,
// a pinch or Ctrl/Cmd with the wheel zooms around the pointer, and a drag on empty space (left or middle button) moves it too.
// Reading code on a card means going down a long way: scrolling has to move, as it does everywhere else on the machine.
import { PanOnScrollMode } from '@xyflow/react'

/** The React Flow props of that model; `locked` (a card is being edited) holds the view still. */
export const navProps = (locked = false) => ({
  panOnScroll: !locked,
  panOnScrollMode: PanOnScrollMode.Free,
  panOnScrollSpeed: 1,
  zoomOnScroll: false,
  zoomOnPinch: !locked,
  panOnDrag: locked ? false : [0, 1],
})

export interface View { k: number; x: number; y: number }

/**
 * The same model for the canvases that draw themselves: the next view after a wheel event at (px, py) inside the canvas.
 * A pinch arrives as a wheel event with ctrlKey (finer steps); Shift with a mouse wheel moves sideways where the browser does not already turn it.
 */
export function wheelView(e: WheelEvent, v: View, px: number, py: number, minK: number, maxK: number): View {
  if (e.ctrlKey || e.metaKey) {
    const k = Math.max(minK, Math.min(maxK, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))))
    return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) }
  }
  // A line or page based wheel (Firefox, some mice) reports small numbers: bring them to pixels.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  const sideways = e.shiftKey && !e.deltaX
  const dx = (sideways ? e.deltaY : e.deltaX) * unit
  const dy = (sideways ? 0 : e.deltaY) * unit
  return { k: v.k, x: v.x - dx, y: v.y - dy }
}
