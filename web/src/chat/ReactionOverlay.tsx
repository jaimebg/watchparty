// Deterministic pseudo-random horizontal offset per reaction id, so re-renders
// (which happen while the float-up animation is in flight) don't reshuffle it.
function leftFor(id: number): number {
  const x = Math.sin(id * 999) * 10000
  return (x - Math.floor(x)) * 90
}

export function ReactionOverlay({
  reactions, onDrop,
}: {
  reactions: { id: number; emoji: string }[]
  onDrop: (id: number) => void
}) {
  return (
    <div className="reaction-overlay">
      {reactions.map(r => (
        <span key={r.id} style={{ left: `${leftFor(r.id)}%` }} onAnimationEnd={() => onDrop(r.id)}>
          {r.emoji}
        </span>
      ))}
    </div>
  )
}
