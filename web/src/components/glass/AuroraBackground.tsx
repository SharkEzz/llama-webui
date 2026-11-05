/** Fond fixe : 4 bulles de dégradé floutées qui dérivent lentement (immobiles si mouvement réduit). */
export function AuroraBackground() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="bubble bubble-violet" />
      <div className="bubble bubble-cyan" />
      <div className="bubble bubble-amber" />
      <div className="bubble bubble-rose" />
    </div>
  )
}
