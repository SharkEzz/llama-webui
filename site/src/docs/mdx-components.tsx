import type { MDXComponents } from 'mdx/types';
import { Anchor } from './Anchor';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { Callout } from './Callout';
import { CodeBlock } from './CodeBlock';
import { Tab, Tabs } from './DocTabs';
import { Endpoint } from './Endpoint';
import { FileTree } from './FileTree';
import { Kbd } from './Kbd';
import { Screenshot } from './Screenshot';
import { Step, Steps } from './Steps';
import { Table } from './Table';

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
