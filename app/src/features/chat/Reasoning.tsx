import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/** Model reasoning: collapsed, open by default while it is being written without a reply. */
export function Reasoning({ text, writing }: { text: string; writing: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? writing;
  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className="mb-2">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}>
        <ChevronRight className={cn('transition-transform', isOpen && 'rotate-90')} />
        <Brain />
        {writing ? 'Thinking…' : 'Reasoning'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 border-l-2 border-border pl-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
