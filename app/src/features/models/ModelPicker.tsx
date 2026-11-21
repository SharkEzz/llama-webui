import type { ModelKind } from '@llama-webui/shared';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { InputGroupButton } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatBytes } from '@/lib/format';
import { readable, useModels } from '@/lib/models';

/**
 * Spacing for the shadcn Command (components/ui stays stock): a taller search box separated from the results by a
 * rule, 8 px around each area and between results.
 */
const COMMAND_SPACING = [
  'p-0',
  '[&_[data-slot=command-input-wrapper]]:border-b [&_[data-slot=command-input-wrapper]]:border-border [&_[data-slot=command-input-wrapper]]:p-2',
  '[&_[data-slot=input-group]]:h-9! [&_[data-slot=input-group]]:*:data-[slot=input-group-addon]:pl-3!',
  '[&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col [&_[cmdk-list-sizer]]:gap-1',
].join(' ');

/** Picks a GGUF from the models folder (button to place inside an InputGroup). */
export function ModelPicker({ kind, onSelect }: { kind: ModelKind; onSelect(path: string): void }) {
  const [open, setOpen] = useState(false);
  const list = useModels((s) => s.list);
  const refresh = useModels((s) => s.refresh);
  const items = (list?.models ?? []).filter(readable).filter((m) => m.kind === kind);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refresh();
      }}
    >
      <PopoverTrigger
        render={
          <InputGroupButton size="icon-xs" aria-label={kind === 'mmproj' ? 'Choose a projector' : 'Choose a model'} />
        }
      >
        <FolderOpen />
      </PopoverTrigger>
      {/* Wide: GGUF paths are long; bounded by the window. */}
      <PopoverContent align="end" className="w-[36rem] max-w-[calc(100vw-2rem)] p-0">
        <Command className={COMMAND_SPACING}>
          <CommandInput placeholder={kind === 'mmproj' ? 'Search projectors…' : 'Search models…'} />
          <CommandList className="max-h-80 p-2">
            <CommandEmpty>{list ? `No files in ${list.setting}` : 'Loading…'}</CommandEmpty>
            {items.map((m) => (
              <CommandItem
                key={m.path}
                value={`${m.relPath} ${m.quant} ${m.arch}`}
                title={m.path}
                className="px-3 py-2"
                onSelect={() => {
                  onSelect(m.path);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-xs">{m.relPath}</span>
                  <span className="num truncate text-xs text-muted-foreground">
                    {[m.quant, formatBytes(m.fileBytes), m.arch].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
