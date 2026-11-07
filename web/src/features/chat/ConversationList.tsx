import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useChat } from '@/lib/chat';
import { cn } from '@/lib/utils';

/** Conversations, la plus récente en haut ; renommer et supprimer par le menu de chaque ligne. */
export function ConversationList({ onNew, onDeleted }: { onNew(): void; onDeleted(id: number): void }) {
  const list = useChat((s) => s.list);
  const currentId = useChat((s) => s.current?.id);
  const rename = useChat((s) => s.rename);
  const remove = useChat((s) => s.remove);
  const [renaming, setRenaming] = useState<{ id: number; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: number; title: string } | null>(null);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Button onClick={onNew}>
        <Plus /> Nouvelle conversation
      </Button>
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" aria-label="Conversations">
        {list.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">Aucune conversation.</p>}
        {list.map((c) =>
          renaming?.id === c.id ? (
            <Input
              key={c.id}
              autoFocus
              value={renaming.title}
              onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenaming(null);
                if (e.key === 'Enter' && renaming.title.trim())
                  void rename(c.id, renaming.title.trim()).finally(() => setRenaming(null));
              }}
              aria-label="Nouveau titre"
            />
          ) : (
            <div key={c.id} className={cn('group flex items-center rounded-md', c.id === currentId && 'bg-accent')}>
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left font-normal"
                nativeButton={false}
                render={<Link to={`/chat/${c.id}`} />}
                aria-current={c.id === currentId ? 'page' : undefined}
              >
                {c.live && (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: pastille « réponse en cours », libellé conservé tel quel
                  <span
                    className="size-2 shrink-0 animate-pulse rounded-full bg-success"
                    aria-label="réponse en cours"
                  />
                )}
                <span className="truncate">{c.title}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 opacity-0 group-hover:opacity-100 data-popup-open:opacity-100"
                    />
                  }
                  aria-label={`Actions pour ${c.title}`}
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setRenaming({ id: c.id, title: c.title })}>
                    <Pencil /> Renommer
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting({ id: c.id, title: c.title })}>
                    <Trash2 /> Supprimer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ),
        )}
      </nav>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer « {deleting?.title} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              La conversation et tous ses messages seront définitivement supprimés.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const d = deleting;
                setDeleting(null);
                if (d) void remove(d.id).then(() => onDeleted(d.id));
              }}
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
