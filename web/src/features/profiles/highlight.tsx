import { type FlagCatalog, flagOf, reservedFlag } from "@llama-webui/shared"
import type { ReactNode } from "react"

const isFlag = (t: string) => t.length > 1 && t.startsWith("-") && !/^-\d/.test(t)

/** Arguments : flags connus en violet, réservés en rose, inconnus en ambre souligné ; valeurs entre guillemets en vert. */
export function highlightArgs(text: string, catalog: FlagCatalog | null): ReactNode {
  return text.split(/(\s+)/).map((tok, i) => {
    if (!tok || /^\s+$/.test(tok)) return tok
    if (isFlag(tok)) {
      const name = tok.split("=")[0]!
      const rest = tok.slice(name.length)
      const cls = reservedFlag(tok)
        ? "text-tone-rose underline decoration-wavy decoration-tone-rose/70"
        : catalog && !flagOf(catalog, tok)
          ? "text-tone-amber underline decoration-dotted decoration-tone-amber/70"
          : "text-tone-violet"
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: jetons positionnels recalculés à chaque rendu
        <span key={i}>
          <span className={cls}>{name}</span>
          {rest && <span className="text-foreground/85">{rest}</span>}
        </span>
      )
    }
    if (/^["']/.test(tok))
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: jetons positionnels recalculés à chaque rendu
        <span key={i} className="text-success">
          {tok}
        </span>
      )
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: jetons positionnels recalculés à chaque rendu
      <span key={i} className="text-foreground/85">
        {tok}
      </span>
    )
  })
}

/** Variables : CLÉ en cyan, « = » discret, valeur normale ; ligne mal formée soulignée en rose. */
export function highlightEnv(text: string): ReactNode {
  return text.split("\n").map((line, i, all) => {
    const nl = i < all.length - 1 ? "\n" : ""
    const eq = line.indexOf("=")
    const key = eq > 0 ? line.slice(0, eq) : ""
    if (!line.trim()) return line + nl
    if (eq <= 0 || !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(key)) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: jetons positionnels recalculés à chaque rendu
        <span key={i}>
          <span className="text-tone-rose underline decoration-wavy decoration-tone-rose/70">{line}</span>
          {nl}
        </span>
      )
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: jetons positionnels recalculés à chaque rendu
      <span key={i}>
        <span className="text-tone-cyan">{key}</span>
        <span className="text-muted-foreground">=</span>
        <span className="text-foreground/90">{line.slice(eq + 1)}</span>
        {nl}
      </span>
    )
  })
}
