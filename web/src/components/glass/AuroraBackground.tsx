/** Fond fixe : deux lueurs très diffuses (accent en haut à gauche, teal en bas à droite) qui dérivent lentement. */
export function AuroraBackground() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="glow glow-1" />
      <div className="glow glow-2" />
    </div>
  );
}
