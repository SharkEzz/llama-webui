import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { highlight } from "@/lib/highlight"

/** Bloc de code : langue, bouton Copier, coloration shiki (texte brut tant qu'elle n'est pas prête). */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    // Pendant le streaming le code change à chaque image : on attend qu'il se pose un instant.
    const t = setTimeout(() => {
      highlight(code, lang).then(
        (h) => live && setHtml(h),
        () => live && setHtml(null),
      )
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [code, lang])

  return (
    <div className="my-3 overflow-hidden rounded-md bg-well ring-1 ring-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="font-mono text-xs text-muted-foreground">{lang || "texte"}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copier le code"
          onClick={() =>
            copyText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      {html ? (
        // HTML produit par shiki à partir du texte (échappé par shiki), pas du HTML de la réponse.
        <div
          className="overflow-x-auto px-3 py-2 font-mono text-[0.8rem] leading-6"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.8rem] leading-6">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
