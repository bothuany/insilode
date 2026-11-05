// The message a board shows when there is nothing to draw, with the actions that lead out of it (a DTO diagram with no DTOs
// offers entities and the suffix setting). What each action does is decided by emptyActions in protocol.ts; this only draws them.
import type { EmptyAction } from './protocol'

export function EmptyState({ message, actions, onAction }: { message: string; actions: EmptyAction[]; onAction: (action: EmptyAction) => void }) {
  return (
    <div className="bd-empty" role="status">
      <p>{message}</p>
      {actions.length > 0 && (
        <div className="bd-empty-actions">
          {actions.map(a => (
            <button key={a.id} className="chip" data-act={`empty-${a.id}`} title={a.hint} onClick={() => onAction(a)}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
