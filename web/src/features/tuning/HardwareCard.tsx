import { deviceRole } from "@llama-webui/shared"
import { Cpu, ListChecks } from "lucide-react"
import { Link } from "react-router"
import { GlassCard } from "@/components/glass/GlassCard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/format"
import { useTuning } from "@/lib/tuning"
import { cn } from "@/lib/utils"

const MiB = 1024 ** 2
const ROLE = { gpu: null, duplicate: "doublon", integrated: "iGPU", host: "hôte" } as const

/** Devices de llama.cpp (--list-devices), RAM et CPU : ce que l'estimateur répartit. */
export function HardwareCard() {
  const hw = useTuning((s) => s.hardware)
  return (
    <GlassCard
      title="Matériel"
      icon={Cpu}
      actions={
        <Button variant="ghost" size="sm" render={<Link to="/system" />} nativeButton={false}>
          <ListChecks /> Vérifications
        </Button>
      }
    >
      {!hw ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <ul className="flex flex-col gap-2">
            {hw.devices
              .filter((d) => d.totalMib > 0)
              .map((d) => {
                const role = ROLE[deviceRole(d, hw.devices)]
                return (
                  <li key={d.id} className={cn("flex flex-col", role && "text-muted-foreground")}>
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-xs">{d.id}</span>
                      {role && <Badge variant="outline">{role}</Badge>}
                      <span className="num ml-auto shrink-0 text-xs">
                        {formatBytes(d.freeMib * MiB)}{" "}
                        <span className="text-muted-foreground">/ {formatBytes(d.totalMib * MiB)}</span>
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={d.name}>
                      {d.name}
                    </span>
                  </li>
                )
              })}
            {hw.devices.length === 0 && (
              <li className="text-muted-foreground">Aucun device : vérifiez le binaire dans les réglages.</li>
            )}
          </ul>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3">
            <dt className="text-muted-foreground">RAM</dt>
            <dd className="num text-right">
              {formatBytes(hw.ramAvailableBytes)}{" "}
              <span className="text-muted-foreground">disponibles / {formatBytes(hw.ramTotalBytes)}</span>
            </dd>
            <dt className="text-muted-foreground">CPU</dt>
            <dd className="min-w-0 truncate text-right" title={hw.cpu.model}>
              {hw.cpu.physicalCores} cœurs · {hw.cpu.model}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Les doublons (une carte vue par deux backends) et l'iGPU ne sont pas proposés par l'estimateur.
          </p>
        </div>
      )}
    </GlassCard>
  )
}
