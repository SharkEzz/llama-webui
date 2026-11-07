/** Fixed background: two very diffuse glows (accent top left, teal bottom right) drifting slowly. */
export function AuroraBackground() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="glow glow-1" />
      <div className="glow glow-2" />
    </div>
  );
}
