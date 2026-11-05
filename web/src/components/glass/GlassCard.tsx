import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface GlassCardProps {
  title?: string
  icon?: LucideIcon
  actions?: ReactNode
  className?: string
  children?: ReactNode
}

export function GlassCard({ title, icon: Icon, actions, className, children }: GlassCardProps) {
  const hasHeader = Boolean(title || actions)
  return (
    <section className={cn("glass p-5", className)}>
      {hasHeader && (
        <header className="mb-4 flex items-center gap-2.5">
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          {title && <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
