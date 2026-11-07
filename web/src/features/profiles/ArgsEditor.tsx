import {
  describeFlag,
  flagOf,
  flagSuggestions,
  reservedFlag,
  reservedFlagMessage,
  unknownFlags,
} from "@llama-webui/shared"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CodeTextarea } from "@/components/CodeTextarea"
import { Command, CommandItem, CommandList } from "@/components/ui/command"
import { useFlags } from "@/lib/flags"
import { parseArgs, wordAt } from "./argsText"
import { highlightArgs } from "./highlight"

interface ArgsEditorProps {
  id?: string
  value: string
  onChange(text: string): void
}

const MAX_SUGGESTIONS = 8

/** Arguments en syntaxe shell, avec autocomplétion des flags, aide du flag sous le curseur et avertissements. */
export function ArgsEditor({ id, value, onChange }: ArgsEditorProps) {
  const { catalog, error: catalogError } = useFlags()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [cursor, setCursor] = useState(0)
  const [active, setActive] = useState(0)
  // Entrée ne complète qu'après un choix aux flèches ; sinon elle garde son rôle (nouvelle ligne).
  const [navigated, setNavigated] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // cmdk attribue lui-même les id de la liste et des options : on les relit pour aria-controls / aria-activedescendant.
  const [aria, setAria] = useState<{ list?: string; active?: string }>({})

  const parsed = useMemo(() => parseArgs(value), [value])
  const at = wordAt(value, cursor)
  const suggestions = catalog && !dismissed ? flagSuggestions(catalog, at.word, MAX_SUGGESTIONS) : []
  const helpFlag = catalog
    ? (flagOf(catalog, at.word) ?? (!at.word.startsWith("-") ? flagOf(catalog, at.previous) : undefined))
    : undefined

  const problems = useMemo(() => {
    if (!Array.isArray(parsed)) return { reserved: [], unknown: [] }
    const reserved = [...new Set(parsed.map(reservedFlag).filter((f): f is string => !!f))]
    const unknown = catalog ? [...new Set(unknownFlags(catalog, parsed))].filter((f) => !reserved.includes(f)) : []
    return { reserved, unknown }
  }, [parsed, catalog])

  const accept = (name: string) => {
    const next = `${value.slice(0, at.start)}${name} ${value.slice(at.end).replace(/^ /, "")}`
    onChange(next)
    const pos = at.start + name.length + 1
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos)
      setCursor(pos)
    })
    setActive(0)
    setNavigated(false)
  }

  const open = suggestions.length > 0
  useLayoutEffect(() => {
    const list = open ? listRef.current?.id || undefined : undefined
    const active = open
      ? listRef.current?.querySelector<HTMLElement>("[cmdk-item][data-selected=true]")?.id || undefined
      : undefined
    if (list !== aria.list || active !== aria.active) setAria({ list, active })
  })

  const track = () => setCursor(ref.current?.selectionStart ?? 0)

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeTextarea
          id={id}
          ref={ref}
          value={value}
          highlight={(t) => highlightArgs(t, catalog)}
          rows={6}
          placeholder={"-c 32768\n-ngl 99\n-fa on"}
          aria-invalid={!Array.isArray(parsed) || problems.reserved.length > 0}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={aria.list}
          aria-activedescendant={aria.active}
          onChange={(text, el) => {
            onChange(text)
            setCursor(el.selectionStart)
            setDismissed(false)
            setActive(0)
            setNavigated(false)
          }}
          onSelect={track}
          onClick={track}
          onKeyUp={(e) => {
            if (!["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"].includes(e.key)) track()
          }}
          onBlur={() => setDismissed(true)}
          onFocus={() => setDismissed(false)}
          onKeyDown={(e) => {
            if (suggestions.length === 0) return
            if (e.key === "ArrowDown") {
              setActive((a) => (a + 1) % suggestions.length)
              setNavigated(true)
            } else if (e.key === "ArrowUp") {
              setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
              setNavigated(true)
            } else if (e.key === "Tab" || (e.key === "Enter" && navigated))
              accept(suggestions[active] ?? suggestions[0]!)
            else if (e.key === "Escape") setDismissed(true)
            else return
            e.preventDefault()
          }}
        />
        {open && (
          <Command
            shouldFilter={false}
            loop
            value={suggestions[active] ?? ""}
            onValueChange={(v) => {
              const i = suggestions.indexOf(v)
              if (i >= 0) setActive(i)
            }}
            // garde le focus dans le textarea pendant le clic sur une suggestion
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-full z-20 mt-1 h-auto rounded-lg! border border-border shadow-xl shadow-surface-shadow backdrop-blur-lg"
          >
            <CommandList ref={listRef} aria-label="Flags suggérés">
              {suggestions.map((name) => {
                const flag = catalog ? flagOf(catalog, name) : undefined
                return (
                  <CommandItem
                    key={name}
                    value={name}
                    onSelect={() => accept(name)}
                    className="items-baseline gap-3 [&>svg:last-child]:hidden"
                  >
                    <span className="shrink-0 font-mono text-xs">
                      {name}
                      {flag?.value && <span className="text-muted-foreground"> {flag.value}</span>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {flag?.help.replace(/\s*\(env: [A-Z0-9_]+\)/g, "")}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        )}
      </div>

      {!Array.isArray(parsed) && <p className="text-sm text-destructive">Lecture impossible : {parsed.error}</p>}
      {problems.reserved.map((f) => (
        <p key={f} className="text-sm text-destructive">
          {reservedFlagMessage(f)}
        </p>
      ))}
      {problems.unknown.length > 0 && (
        <p className="text-sm text-warning">Inconnu de ce llama-server : {problems.unknown.join(", ")}</p>
      )}
      {helpFlag ? (
        <p className="rounded-md bg-well px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
          {describeFlag(helpFlag)}
        </p>
      ) : catalogError ? (
        <p className="text-xs text-muted-foreground">Aide des flags indisponible : {catalogError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Tapez « - » pour voir les flags ; Tab complète, ↑ ↓ puis Entrée choisit.
        </p>
      )}
    </div>
  )
}
