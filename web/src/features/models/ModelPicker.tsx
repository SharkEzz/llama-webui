import { useState } from "react"
import { FolderOpen } from "lucide-react"
import type { ModelKind } from "@llama-webui/shared"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { InputGroupButton } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatBytes } from "@/lib/format"
import { readable, useModels } from "@/lib/models"

/** Choix d'un GGUF du dossier des modèles (bouton à placer dans un InputGroup). */
export function ModelPicker({ kind, onSelect }: { kind: ModelKind; onSelect(path: string): void }) {
  const [open, setOpen] = useState(false)
  const list = useModels((s) => s.list)
  const refresh = useModels((s) => s.refresh)
  const items = (list?.models ?? []).filter(readable).filter((m) => m.kind === kind)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) void refresh()
      }}
    >
      <PopoverTrigger
        render={<InputGroupButton size="icon-xs" aria-label={kind === "mmproj" ? "Choisir un projecteur" : "Choisir un modèle"} />}
      >
        <FolderOpen />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <Command>
          <CommandInput placeholder={kind === "mmproj" ? "Chercher un projecteur…" : "Chercher un modèle…"} />
          <CommandList>
            <CommandEmpty>{list ? `Aucun fichier dans ${list.setting}` : "Chargement…"}</CommandEmpty>
            {items.map((m) => (
              <CommandItem
                key={m.path}
                value={`${m.relPath} ${m.quant} ${m.arch}`}
                onSelect={() => {
                  onSelect(m.path)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.relPath}</span>
                <span className="num shrink-0 text-xs text-muted-foreground">
                  {m.quant} · {formatBytes(m.fileBytes)}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
