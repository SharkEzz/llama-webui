import { MessageSquare } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useChat } from '@/lib/chat';
import { Message } from './Message';

/** Conversation thread; stays pinned to the bottom unless the user scrolls up to read. */
export function Thread({ canSend }: { canSend: boolean }) {
  const current = useChat((s) => s.current);
  const streaming = useChat((s) => s.streaming);
  const regenerate = useChat((s) => s.regenerate);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: current.id is a trigger: re-pin to the bottom on every conversation change
  useLayoutEffect(() => {
    stick.current = true;
  }, [current?.id]);

  const messages = current?.messages ?? [];
  const lastAssistant = messages.findLast((m) => m.role === 'assistant');
  return (
    <div
      ref={box}
      className="min-h-0 flex-1 overflow-y-auto pr-2"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <MessageSquare className="size-8" />
          <p className="text-sm">
            {current ? 'Write the first message.' : 'Pick a conversation or start typing to begin one.'}
          </p>
        </div>
      ) : (
        <div className="mx-auto flex max-w-4xl flex-col gap-4 py-2">
          {messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              live={streaming?.assistantId === m.id ? streaming : undefined}
              canRegenerate={canSend && !streaming && m.id === lastAssistant?.id}
              onRegenerate={() => void regenerate()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
