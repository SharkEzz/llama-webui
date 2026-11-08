import { Children, isValidElement } from 'react';
import { TabsContent, TabsList, Tabs as TabsRoot, TabsTrigger } from '@/components/ui/tabs';

/** Content of one tab: <Tab title="…">Markdown</Tab>, inside <Tabs>. */
export function Tab({ children }: { title: string; children: React.ReactNode }) {
  return <>{children}</>;
}

/** <Tabs><Tab title="A">…</Tab><Tab title="B">…</Tab></Tabs>; the first tab is open. */
export function Tabs({ children }: { children: React.ReactNode }) {
  const tabs = Children.toArray(children).filter(
    (c): c is React.ReactElement<{ title: string; children: React.ReactNode }> => isValidElement(c),
  );
  return (
    <TabsRoot defaultValue={0} className="my-6">
      <TabsList className="h-auto max-w-full flex-wrap">
        {tabs.map((t, i) => (
          <TabsTrigger key={t.props.title} value={i}>
            {t.props.title}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t, i) => (
        <TabsContent key={t.props.title} value={i} className="text-base [&>:first-child]:mt-4">
          {t.props.children}
        </TabsContent>
      ))}
    </TabsRoot>
  );
}
