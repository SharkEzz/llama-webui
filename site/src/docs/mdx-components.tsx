import type { MDXComponents } from 'mdx/types';
import { Link } from 'react-router';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { Callout } from './Callout';
import { CodeBlock } from './CodeBlock';
import { Tab, Tabs } from './DocTabs';
import { Endpoint } from './Endpoint';
import { FileTree } from './FileTree';
import { Screenshot } from './Screenshot';
import { Step, Steps } from './Steps';

/**
 * Internal links ("/docs/…") go through React Router, which adds the /llama-webui basename and navigates
 * client-side. Anchors and external links stay plain.
 */
function Anchor({ href = '', children, ...props }: React.ComponentProps<'a'>) {
  if (href.startsWith('/')) {
    return (
      <Link to={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

function Table(props: React.ComponentProps<'table'>) {
  return (
    <div className="my-6 overflow-x-auto rounded-xl ring-1 ring-border">
      <table className="w-full text-sm [&_td:first-child_code]:whitespace-nowrap" {...props} />
    </div>
  );
}

/** A key or shortcut: <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd>. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.8em] font-medium">
      {children}
    </kbd>
  );
}

export const mdxComponents: MDXComponents = {
  a: Anchor,
  pre: CodeBlock,
  table: Table,
  thead: (props) => <thead className="bg-muted/50" {...props} />,
  th: (props) => <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap" {...props} />,
  td: (props) => <td className="border-t border-border px-4 py-2.5 align-top" {...props} />,
  ArchitectureDiagram,
  Callout,
  Endpoint,
  FileTree,
  Kbd,
  Screenshot,
  Step,
  Steps,
  Tab,
  Tabs,
};
