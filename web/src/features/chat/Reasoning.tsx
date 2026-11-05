import { useState } from "react"
import { Brain, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/** Réflexion du modèle : repliée, ouverte d'office tant qu'elle s'écrit sans réponse. */
export function Reasoning({ text, writing }: { text: string; writing: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? writing
  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className="mb-2">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}>
        <ChevronRight className={cn("transition-transform", isOpen && "rotate-90")} />
        <Brain />
        {writing ? "Réflexion en cours…" : "Réflexion"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 border-l-2 border-border pl-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}
