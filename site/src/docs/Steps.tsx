/**
 * A numbered procedure: <Steps><Step title="…">Markdown</Step>…</Steps>. Numbers come from a CSS counter, so MDX
 * whitespace between the steps does not matter.
 */
export function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="my-8 list-none pl-0 [counter-reset:step]">{children}</ol>;
}

export function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="relative my-0 pb-8 pl-11 [counter-increment:step] before:absolute before:top-0 before:left-0 before:flex before:size-7 before:items-center before:justify-center before:rounded-full before:bg-muted before:font-mono before:text-xs before:font-medium before:text-foreground before:content-[counter(step)] after:absolute after:top-9 after:bottom-1 after:left-3.5 after:w-px after:bg-border last:pb-0 last:after:hidden">
      <p className="my-0! font-semibold text-foreground">{title}</p>
      <div className="[&>:first-child]:mt-2 [&>:last-child]:mb-0">{children}</div>
    </li>
  );
}
