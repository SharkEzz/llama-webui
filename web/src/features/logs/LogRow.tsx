import type { LogLine } from "@llama-webui/shared"
import { cn } from "@/lib/utils"

const LEVEL: Record<LogLine["level"], string> = {
  error: "text-tone-rose",
  warn: "text-tone-amber",
  info: "text-foreground/85",
  debug: "text-muted-foreground/70",
}

/** Une ligne de log : couleur par niveau, lignes de llama-webui en violet, correspondance de recherche surlignée. */
export function LogRow({ line, query, className }: { line: LogLine; query?: string; className?: string }) {
  const own = line.text.startsWith("[llama-webui]")
  return (
    <div className={cn("flex min-w-0 gap-2 font-mono text-xs leading-5", className)}>
      {line.kind !== "other" && (
        <span className="w-8 shrink-0 text-muted-foreground/60" aria-hidden="true">
          {line.kind}
        </span>
      )}
      <span className={cn("min-w-0 whitespace-pre-wrap break-all", own ? "text-tone-violet" : LEVEL[line.level])}>
        <Highlight text={line.text} query={query} />
      </span>
    </div>
  )
}

function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query) return text
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-tone-amber/30 text-inherit">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}
