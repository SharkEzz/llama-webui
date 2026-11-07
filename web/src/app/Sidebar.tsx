import { NavLink } from "react-router"
import { cn } from "@/lib/utils"
import { type AppRoute, ROUTES } from "./routes"

const main = ROUTES.filter((r) => r.path !== "/settings")
const settings = ROUTES.find((r) => r.path === "/settings")!

function Item({ route }: { route: AppRoute }) {
  const Icon = route.icon
  return (
    <NavLink
      to={route.path}
      end={route.path === "/"}
      title={route.label}
      className={({ isActive }) =>
        cn(
          "group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors",
          "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
          <Icon className={cn("size-4 shrink-0", isActive && "text-sidebar-primary")} aria-hidden="true" />
          <span className="hidden truncate md:inline">{route.label}</span>
        </>
      )}
    </NavLink>
  )
}

export function Sidebar() {
  return (
    <aside className="sticky top-4 m-4 mr-0 flex h-[calc(100dvh-2rem)] flex-col rounded-lg border border-sidebar-border bg-sidebar p-3 text-sidebar-foreground shadow-lg shadow-surface-shadow backdrop-blur-(--surface-blur)">
      <div className="flex h-10 items-center gap-2.5 px-2">
        <LlamaMark />
        <span className="hidden text-[0.9375rem] font-semibold tracking-tight md:inline">llama-webui</span>
      </div>
      <nav aria-label="Navigation principale" className="mt-4 flex flex-1 flex-col gap-0.5">
        {main.map((r) => (
          <Item key={r.path} route={r} />
        ))}
      </nav>
      <div className="border-t border-sidebar-border pt-3">
        <Item route={settings} />
      </div>
    </aside>
  )
}

/** Monogramme : trois barres de hauteur croissante, comme un débit qui monte. */
function LlamaMark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden="true">
      <rect x="2" y="11" width="4" height="7" rx="1.5" fill="var(--tone-cyan)" />
      <rect x="8" y="7" width="4" height="11" rx="1.5" fill="var(--tone-violet)" />
      <rect x="14" y="2" width="4" height="16" rx="1.5" fill="var(--tone-rose)" />
    </svg>
  )
}
