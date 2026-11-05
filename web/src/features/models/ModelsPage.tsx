import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { Boxes, RefreshCw, Search } from "lucide-react"
import type { ModelEntry } from "@llama-webui/shared"
import { GLASS } from "@/components/glass/glass"
import { GlassCard } from "@/components/glass/GlassCard"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatBytes, formatInt, formatParams } from "@/lib/format"
import { useModels } from "@/lib/models"
import { cn } from "@/lib/utils"
import { ModelDetailDialog } from "./ModelDetailDialog"

type KindFilter = "model" | "mmproj" | "all"

const matches = (m: ModelEntry, q: string) =>
  !q || [m.relPath, ...(m.ok ? [m.name, m.arch, m.quant] : [])].some((s) => s.toLowerCase().includes(q))

/** Les GGUF du dossier des modèles, avec les métadonnées de leur en-tête. */
export function ModelsPage() {
  const { list, error, loading, refresh } = useModels()
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<KindFilter>("model")
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => void refresh(), [refresh])

  const q = query.trim().toLowerCase()
  const rows = useMemo(
    () => (list?.models ?? []).filter((m) => (kind === "all" || !m.ok || m.kind === kind) && matches(m, q)),
    [list, kind, q],
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Modèles</h1>
          {list && <p className="font-mono text-sm text-muted-foreground">{list.dir}</p>}
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} /> Rescanner
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className={GLASS}>
          <AlertTitle>Scan impossible</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!list ? (
        !error && <Skeleton className="h-64" />
      ) : list.models.length === 0 ? (
        <Alert className={GLASS}>
          <Boxes />
          <AlertTitle>Aucun fichier GGUF dans {list.setting}</AlertTitle>
          <AlertDescription>
            <p>
              Déposez des modèles dans ce dossier ou changez-le dans les <Link to="/settings" className="underline underline-offset-4">Réglages</Link>.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <GlassCard>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <InputGroup className="max-w-sm">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Fichier, nom, architecture, quantification" />
              </InputGroup>
              <Tabs value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
                <TabsList>
                  <TabsTrigger value="model">Modèles</TabsTrigger>
                  <TabsTrigger value="mmproj">Projecteurs</TabsTrigger>
                  <TabsTrigger value="all">Tous</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun fichier ne correspond.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fichier</TableHead>
                    <TableHead>Archi</TableHead>
                    <TableHead>Quant</TableHead>
                    <TableHead className="text-right">Taille</TableHead>
                    <TableHead className="text-right">Paramètres</TableHead>
                    <TableHead className="text-right">Couches</TableHead>
                    <TableHead className="text-right">Contexte</TableHead>
                    <TableHead className="text-right">Experts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.path} className={cn(m.ok && "cursor-pointer")} onClick={() => m.ok && setOpen(m.path)}>
                      <TableCell className="max-w-md">
                        <div className="truncate font-mono text-xs">{m.relPath}</div>
                        {m.ok && m.name && <div className="truncate text-xs text-muted-foreground">{m.name}</div>}
                      </TableCell>
                      {m.ok ? (
                        <>
                          <TableCell>{m.arch}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{m.quant}</Badge>
                          </TableCell>
                          <TableCell className="num text-right">{formatBytes(m.fileBytes)}</TableCell>
                          <TableCell className="num text-right">{formatParams(m.params)}</TableCell>
                          <TableCell className="num text-right">{formatInt(m.blockCount)}</TableCell>
                          <TableCell className="num text-right">{m.contextLength > 0 ? formatInt(m.contextLength) : "—"}</TableCell>
                          <TableCell className="num text-right">{m.expertCount > 0 ? `${m.expertCount} / ${m.expertUsedCount}` : "—"}</TableCell>
                        </>
                      ) : (
                        <TableCell colSpan={7}>
                          <Badge variant="destructive">illisible</Badge>
                          <span className="ml-2 text-xs text-muted-foreground">{m.error}</span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </GlassCard>
      )}
      <ModelDetailDialog path={open} onClose={() => setOpen(null)} />
    </div>
  )
}
