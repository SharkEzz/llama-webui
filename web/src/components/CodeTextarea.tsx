import { type ComponentProps, type ReactNode, useRef } from "react"
import { cn } from "@/lib/utils"

// Boîte commune au textarea et à son calque coloré : mêmes bordure, marges, police et retours à la ligne.
const BOX = "rounded-lg border px-2.5 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words"

interface CodeTextareaProps extends Omit<ComponentProps<"textarea">, "value" | "onChange"> {
  value: string
  onChange(value: string, el: HTMLTextAreaElement): void
  /** Rendu coloré du texte (mêmes caractères, dans le même ordre). */
  highlight(text: string): ReactNode
}

/**
 * Textarea à coloration syntaxique : le texte réel est transparent, un <pre> coloré identique est dessiné dessous.
 * L'édition reste native (curseur, sélection, presse-papiers, annuler).
 */
export function CodeTextarea({ value, onChange, highlight, className, ref, onScroll, ...props }: CodeTextareaProps) {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className={cn("relative", className)}>
      <pre
        ref={pre}
        aria-hidden="true"
        className={cn(
          BOX,
          "pointer-events-none absolute inset-0 m-0 overflow-hidden border-transparent text-foreground",
        )}
      >
        {highlight(value)}
        {/* une dernière ligne vide doit aussi occuper sa hauteur */}
        {"\n"}
      </pre>
      <textarea
        ref={ref}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value, e.target)}
        onScroll={(e) => {
          if (pre.current) pre.current.scrollTop = e.currentTarget.scrollTop
          onScroll?.(e)
        }}
        className={cn(
          BOX,
          "relative block field-sizing-content min-h-16 w-full resize-y border-input bg-well text-transparent caret-foreground outline-none transition-colors",
          "selection:bg-primary/30 selection:text-transparent placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "aria-invalid:border-destructive/50 aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        )}
        {...props}
      />
    </div>
  )
}
