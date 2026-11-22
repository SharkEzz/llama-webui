import {
  describeFlag,
  flagOf,
  flagSuggestions,
  reservedFlag,
  reservedFlagMessage,
  unknownFlags,
} from '@llama-webui/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CodeTextarea } from '@/components/CodeTextarea';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import { useFlags } from '@/lib/flags';
import { parseArgs, wordAt } from './argsText';
import { highlightArgs } from './highlight';

/**
 * Copies onto the field the ids cmdk assigns itself (it writes `id` after the props it is given): the list's in
 * `aria-controls`, the selected option's in `aria-activedescendant`; without a list, neither.
 */
function copyListIds(field: HTMLElement, list: HTMLElement | null) {
  const ids = {
    'aria-controls': list?.id,
    'aria-activedescendant': list?.querySelector<HTMLElement>('[cmdk-item][data-selected=true]')?.id,
  };
  for (const [name, id] of Object.entries(ids)) {
    if (id) field.setAttribute(name, id);
    else field.removeAttribute(name);
  }
}

interface ArgsEditorProps {
  id?: string;
  value: string;
  onChange: (text: string) => void;
}

/** Arguments in shell syntax, with flag autocompletion, help for the flag under the cursor, and warnings. */
export function ArgsEditor({ id, value, onChange }: ArgsEditorProps) {
  const { catalog, error: catalogError } = useFlags();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  // Enter only completes after picking with the arrows; otherwise it keeps its role (new line). Never rendered: a ref.
  const navigated = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseArgs(value), [value]);
  const at = wordAt(value, cursor);
  const suggestions = catalog && !dismissed ? flagSuggestions(catalog, at.word) : [];
  const helpFlag = catalog
    ? (flagOf(catalog, at.word) ?? (!at.word.startsWith('-') ? flagOf(catalog, at.previous) : undefined))
    : undefined;

  const problems = useMemo(() => {
    if (!Array.isArray(parsed)) return { reserved: [], unknown: [] };
    const reserved = [...new Set(parsed.map(reservedFlag).filter((f): f is string => Boolean(f)))];
    const unknown = catalog ? [...new Set(unknownFlags(catalog, parsed))].filter((f) => !reserved.includes(f)) : [];
    return { reserved, unknown };
  }, [parsed, catalog]);

  const accept = (name: string) => {
    const next = `${value.slice(0, at.start)}${name} ${value.slice(at.end).replace(/^ /, '')}`;
    onChange(next);
    const pos = at.start + name.length + 1;
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      setCursor(pos);
    });
    setActive(0);
    navigated.current = false;
  };

  const open = suggestions.length > 0;
  // aria-controls and aria-activedescendant are written on the textarea here, not rendered: they are ids cmdk sets in
  // the DOM, and the selected one moves when cmdk re-marks `data-selected`, without a render of this component. No
  // state, so nothing here can render again. cmdk gives its list a new composed ref on every render: an object ref,
  // never a callback with effects.
  useLayoutEffect(() => {
    const field = ref.current;
    const list = open ? listRef.current : null;
    if (!field) return;
    copyListIds(field, list);
    if (!list) return;
    const observer = new MutationObserver(() => copyListIds(field, list));
    observer.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-selected'] });
    return () => observer.disconnect();
    // The refs are listed although stable: they are handed to other components (CodeTextarea, cmdk's list)
  }, [open, ref, listRef]);

  // Every matching flag is listed: keep the highlighted one in view while the arrows move through the list.
  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector('[cmdk-item][data-selected=true]')?.scrollIntoView({ block: 'nearest' });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- active is a trigger: cmdk marks the item from it
  }, [open, active, listRef]);

  const track = () => setCursor(ref.current?.selectionStart ?? 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <CodeTextarea
          id={id}
          ref={ref}
          value={value}
          highlight={(t) => highlightArgs(t, catalog)}
          rows={6}
          placeholder={'-c 32768\n-ngl 99\n-fa on'}
          aria-invalid={!Array.isArray(parsed) || problems.reserved.length > 0}
          // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- aria-controls is written by the layout effect above, from the id cmdk gives its list
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          onChange={(text, el) => {
            onChange(text);
            setCursor(el.selectionStart);
            setDismissed(false);
            setActive(0);
            navigated.current = false;
          }}
          onSelect={track}
          onClick={track}
          onKeyUp={(e) => {
            if (!['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) track();
          }}
          onBlur={() => setDismissed(true)}
          onFocus={() => setDismissed(false)}
          onKeyDown={(e) => {
            if (suggestions.length === 0) return;
            if (e.key === 'ArrowDown') {
              setActive((a) => (a + 1) % suggestions.length);
              navigated.current = true;
            } else if (e.key === 'ArrowUp') {
              setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
              navigated.current = true;
            } else if (e.key === 'Tab') accept(suggestions[active] ?? suggestions[0]!);
            // An Enter that ends an IME composition picks the text, it does not complete the flag
            else if (e.key === 'Enter' && navigated.current && !e.nativeEvent.isComposing)
              accept(suggestions[active] ?? suggestions[0]!);
            else if (e.key === 'Escape') setDismissed(true);
            else return;
            e.preventDefault();
          }}
        />
        {open && (
          <Command
            shouldFilter={false}
            loop
            value={suggestions[active] ?? ''}
            onValueChange={(v) => {
              const i = suggestions.indexOf(v);
              if (i >= 0) setActive(i);
            }}
            // keep focus in the textarea while clicking a suggestion
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-full z-20 mt-1 h-auto rounded-lg! border border-border shadow-surface inset-shadow-highlight backdrop-blur-(--surface-blur)"
          >
            <CommandList ref={listRef} aria-label="Suggested flags">
              {suggestions.map((name) => {
                const flag = catalog ? flagOf(catalog, name) : undefined;
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
                      {flag?.help.replaceAll(/\s*\(env: [A-Z0-9_]+\)/g, '')}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        )}
      </div>

      {!Array.isArray(parsed) && <p className="text-sm text-destructive">Could not parse: {parsed.error}</p>}
      {problems.reserved.map((f) => (
        <p key={f} className="text-sm text-destructive">
          {reservedFlagMessage(f)}
        </p>
      ))}
      {problems.unknown.length > 0 && (
        <p className="text-sm text-warning">Unknown to this llama-server: {problems.unknown.join(', ')}</p>
      )}
      {helpFlag ? (
        <p className="rounded-md bg-well inset-shadow-well px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
          {describeFlag(helpFlag)}
        </p>
      ) : catalogError ? (
        <p className="text-xs text-muted-foreground">Flag help unavailable: {catalogError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">Type “-” to see flags; Tab completes, ↑ ↓ then Enter picks.</p>
      )}
    </div>
  );
}
