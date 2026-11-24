import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { childPath, childrenOf, isBranch, preview, sizeOf } from '@/lib/debug/inspect';
import { cn } from '@/lib/utils';

/** The children a branch shows at first, then by as many again. */
const PAGE = 100;

/** The colour of a leaf, by its type. */
function leafTone(value: unknown): string {
  if (typeof value === 'string') return 'text-tone-teal';
  if (typeof value === 'number' || typeof value === 'bigint') return 'text-tone-blue';
  if (typeof value === 'boolean') return 'text-tone-amber';
  return 'text-muted-foreground';
}

/** A branch on one line: its kind and size, `Array(12)`, `{ 5 keys }`. */
function branchLabel(value: object): string {
  const size = sizeOf(value);
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return preview(value);
  return `{ ${size} ${size === 1 ? 'key' : 'keys'} }`;
}

function Node({ label, value, path, depth }: { label: string; value: unknown; path: string; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const [shown, setShown] = useState(PAGE);
  const indent = { paddingLeft: `${depth * 0.75}rem` };

  if (!isBranch(value)) {
    return (
      <li className="flex min-w-0 gap-1.5 py-px pl-4" style={indent} title={path}>
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <span className={cn('min-w-0 truncate', leafTone(value))} title={preview(value, 2000)}>
          {preview(value)}
        </span>
      </li>
    );
  }

  const children = open ? childrenOf(value) : [];
  const inArray = Array.isArray(value) || value instanceof Set;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1 rounded py-px text-left hover:bg-accent"
        style={indent}
        title={path}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate text-muted-foreground">{open ? branchLabel(value) : preview(value)}</span>
      </button>
      {open && (
        <ul>
          {children.slice(0, shown).map(([key, child]) => (
            <Node key={key} label={key} value={child} path={childPath(path, key, inArray)} depth={depth + 1} />
          ))}
          {children.length > shown && (
            <li style={{ paddingLeft: `${(depth + 1) * 0.75 + 1}rem` }}>
              <button
                type="button"
                onClick={() => setShown(shown + PAGE)}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                {children.length - shown} more
              </button>
            </li>
          )}
          {children.length === 0 && (
            <li className="text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 0.75 + 1}rem` }}>
              empty
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * A value as a tree that opens branch by branch: only what is open is read and rendered, a long list by pages of a
 * hundred. The root is open.
 */
export function JsonTree({ value, label }: { value: unknown; label: string }) {
  return (
    <ul className="font-mono text-[0.7rem] leading-relaxed">
      <Node label={label} value={value} path="" depth={0} />
    </ul>
  );
}
