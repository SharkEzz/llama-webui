import type { ChatMessage } from "@llama-webui/shared"
import { Check, Copy, RotateCcw } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { Markdown } from "./Markdown"
import { MessageStats } from "./MessageStats"
import { Reasoning } from "./Reasoning"

interface MessageProps {
  message: ChatMessage
  /** Texte en cours d'écriture (réponse en streaming). */
  live?: { content: string; reasoning: string }
  canRegenerate: boolean
  onRegenerate(): void
}

export function Message({ message, live, canRegenerate, onRegenerate }: MessageProps) {
  const [copied, setCopied] = useState(false)
  if (message.role === "user")
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap">
        {message.content}
      </div>
    )

  const content = live ? live.content : message.content
  const reasoning = live ? live.reasoning : message.reasoning
  const writing = live !== undefined
  return (
    <div className="group flex flex-col gap-1 text-sm">
      {reasoning && <Reasoning text={reasoning} writing={writing && !content} />}
      {content ? (
        <Markdown text={content} />
      ) : (
        writing && !reasoning && <p className="animate-pulse text-muted-foreground">…</p>
      )}
      {message.status === "stopped" && (
        <Badge variant="outline" className="w-fit">
          interrompue
        </Badge>
      )}
      {message.status === "error" && (
        <p className="flex items-start gap-2 text-destructive">
          <Badge variant="destructive" className="shrink-0">
            erreur
          </Badge>
          <span>{message.error}</span>
        </p>
      )}
      {!writing && (
        <div className="flex items-center gap-1">
          {message.stats && <MessageStats stats={message.stats} />}
          <div className="ml-auto flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
            {content && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copier la réponse"
                onClick={() =>
                  copyText(content).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            )}
            {canRegenerate && (
              <Button variant="ghost" size="icon-xs" aria-label="Régénérer la réponse" onClick={onRegenerate}>
                <RotateCcw />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
