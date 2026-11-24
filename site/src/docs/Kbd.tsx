/** A key or shortcut: <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd>. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.8em] font-medium">
      {children}
    </kbd>
  );
}
