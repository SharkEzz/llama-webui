/** Fixed ambient aurora + subtle radial grid mounted behind the frosted glass UI. */
export function AuroraBackground() {
  return (
    <>
      <div className="aurora" aria-hidden="true">
        <div className="glow glow-1" />
        <div className="glow glow-2" />
        <div className="glow glow-3" />
      </div>
      <div className="pointer-events-none fixed inset-0 -z-1 bg-grid" aria-hidden="true" />
    </>
  );
}
