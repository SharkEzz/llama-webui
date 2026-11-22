import { File, Folder } from 'lucide-react';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { HScroll } from './HScroll';

type El = ReactElement<{ children?: ReactNode }>;
const isEl = (n: ReactNode): n is El => isValidElement(n);
const tag = (n: ReactNode) => (isEl(n) && typeof n.type === 'string' ? n.type : null);
const isTag = (n: ReactNode, name: string): n is El => tag(n) === name;

/** A list item's own content (text, a leading `name`), without its nested list; loose items wrap it in a <p>. */
function split(children: ReactNode): { own: ReactNode[]; nested: El | null } {
  const own: ReactNode[] = [];
  let nested: El | null = null;
  for (const c of Children.toArray(children)) {
    if (isTag(c, 'ul')) nested = c;
    else if (isTag(c, 'p')) own.push(...Children.toArray(c.props.children));
    else own.push(c);
  }
  return { own, nested };
}

function Items({ list }: { list: El }) {
  const items = Children.toArray(list.props.children).filter((c): c is El => tag(c) === 'li');
  return (
    <ul className="flex flex-col">
      {items.map((li, i) => {
        const { own, nested } = split(li.props.children);
        const [first, ...rest] = own;
        // The text of the leading `name` (a string: the Markdown of inline code)
        const code = isTag(first, 'code') ? first.props.children : null;
        const name = typeof code === 'string' ? code : null;
        const dir = name?.endsWith('/') ?? false;
        const Icon = dir ? Folder : File;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- static tree written in the page
          <li key={i} className="relative">
            <div className="flex items-baseline gap-2 py-0.5">
              <Icon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden="true" />
              {name ? (
                <>
                  <span className={dir ? 'font-medium text-foreground' : 'text-foreground'}>{name}</span>
                  {rest.length > 0 && <span className="font-sans text-muted-foreground">{rest}</span>}
                </>
              ) : (
                <span>{own}</span>
              )}
            </div>
            {nested && (
              <div className="ml-[0.4375rem] border-l border-border pl-4">
                <Items list={nested} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A file tree written as a Markdown list, one entry per item: the name in backticks (a trailing "/" for a folder),
 * then an optional description. Nested lists are subfolders.
 *
 * <FileTree>
 * - `server/` the Node.js process
 *   - `routes/` one file per API domain
 * - `package.json`
 * </FileTree>
 */
export function FileTree({ children }: { children: ReactNode }) {
  const list = Children.toArray(children).find((c) => isTag(c, 'ul'));
  return (
    <HScroll className="not-prose my-6 rounded-xl bg-well px-4 py-3 font-mono text-[0.8125rem] leading-6 ring-1 inset-shadow-well ring-border">
      {list ? <Items list={list} /> : children}
    </HScroll>
  );
}
