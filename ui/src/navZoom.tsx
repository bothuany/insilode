// Cmd with the wheel zooms even when the canvas does not hold the keyboard focus. React Flow zooms on Cmd only after it saw the key go
// down in this document; with the focus in the editor beside the canvas (or on the page around it) it never does, and the wheel pans.
// Ctrl with the wheel and a pinch need no help: both arrive with ctrlKey, which React Flow reads from the wheel event itself.
import { useEffect } from 'react'
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { wheelView } from './nav'

export function MetaWheelZoom({ off = false }: { off?: boolean }) {
  const el = useStore(s => s.domNode)
  const store = useStoreApi()
  const { getViewport, setViewport } = useReactFlow()
  useEffect(() => {
    if (!el || off) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey || e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const r = el.getBoundingClientRect()
      const { minZoom, maxZoom } = store.getState()
      const v = wheelView(e, { k: zoom, x, y }, e.clientX - r.left, e.clientY - r.top, minZoom, maxZoom)
      void setViewport({ x: v.x, y: v.y, zoom: v.k })
    }
    // Capture: before React Flow's own wheel handler pans.
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [el, off, store, getViewport, setViewport])
  return null
}
