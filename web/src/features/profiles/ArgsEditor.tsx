import { useMemo, useRef, useState } from "react"
import { complete, describeFlag, flagOf, reservedFlag, reservedFlagMessage, unknownFlags } from "@llama-webui/shared"
import { CodeTextarea } from "@/components/CodeTextarea"
import { useFlags } from "@/lib/flags"
import { cn } from "@/lib/utils"
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
  const [dismissed, setDismissed] = useState(false)

  const parsed = useMemo(() => parseArgs(value), [value])
  const at = wordAt(value, cursor)
  const suggestions =
    catalog && !dismissed && at.word.startsWith("-") && !at.word.includes("=")
      ? complete(catalog, at.word).candidates.filter((c) => c !== at.word).slice(0, MAX_SUGGESTIONS)
      : []
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
  }

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
          onChange={(text, el) => {
            onChange(text)
            setCursor(el.selectionStart)
            setDismissed(false)
            setActive(0)
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
            if (e.key === "ArrowDown") setActive((a) => (a + 1) % suggestions.length)
            else if (e.key === "ArrowUp") setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
            else if (e.key === "Tab" || e.key === "Enter") accept(suggestions[active] ?? suggestions[0]!)
            else if (e.key === "Escape") setDismissed(true)
            else return
            e.preventDefault()
          }}
        />
        {suggestions.length > 0 && (
          <ul
            role="listbox"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-white/10 bg-popover p-1 shadow-xl shadow-black/40 backdrop-blur-lg"
          >
            {suggestions.map((name, i) => {
              const flag = catalog ? flagOf(catalog, name) : undefined
              return (
                <li
                  key={name}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    accept(name)
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn("flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5", i === active && "bg-accent")}
                >
                  <span className="shrink-0 font-mono text-xs">
                    {name}
                    {flag?.value && <span className="text-muted-foreground"> {flag.value}</span>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{flag?.help.replace(/\s*\(env: [A-Z0-9_]+\)/g, "")}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {!Array.isArray(parsed) && <p className="text-sm text-destructive">Lecture impossible : {parsed.error}</p>}
      {problems.reserved.map((f) => (
        <p key={f} className="text-sm text-destructive">
          {reservedFlagMessage(f)}
        </p>
      ))}
      {problems.unknown.length > 0 && (
        <p className="text-sm text-tone-amber">Inconnu de ce llama-server : {problems.unknown.join(", ")}</p>
      )}
      {helpFlag ? (
        <p className="rounded-md bg-white/5 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{describeFlag(helpFlag)}</p>
      ) : catalogError ? (
        <p className="text-xs text-muted-foreground">Aide des flags indisponible : {catalogError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">Tapez « - » pour voir les flags ; Tab ou Entrée complète.</p>
      )}
    </div>
  )
}
