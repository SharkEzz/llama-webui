import { contextUsed } from '@llama-webui/shared';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { GLASS } from '@/components/glass/glass';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useChat } from '@/lib/chat';
import { formatInt } from '@/lib/format';
import { useServer } from '@/lib/server';
import { stem } from '@/lib/stem';
import { cn } from '@/lib/utils';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { SamplingPanel } from './SamplingPanel';
import { Thread } from './Thread';
import { type ServerProps, useServerProps } from './useServerProps';

/** Context used by the conversation after the last reply (cached prompt + new prompt + reply) out of the server's. */
function ContextGauge({ props }: { props: ServerProps | null }) {
  const current = useChat((s) => s.current);
  const nCtx = props?.default_generation_settings?.n_ctx;
  const last = current?.messages.findLast((m) => m.role === 'assistant' && m.stats);
  if (!nCtx || !last?.stats) return null;
  const used = contextUsed(last.stats);
  const pct = Math.min(100, (used / nCtx) * 100);
  const high = pct >= 85;
  return (
    <div
      className="flex min-w-48 flex-col gap-1"
      title="Conversation so far (cached prompt, new message and the last reply), out of the server context"
    >
      <div className={cn('num flex justify-between gap-3 text-xs', high ? 'text-warning' : 'text-muted-foreground')}>
        <span>Context</span>
        <span>
          {formatInt(used)} / {formatInt(nCtx)} tokens
        </span>
      </div>
      <Progress value={pct} aria-label="Context used" />
      {high && <p className="text-xs text-warning">Almost full: start a new conversation.</p>}
    </div>
  );
}

/** Chat with the active llama-server: conversations, streaming thread, per-conversation settings. */
export function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { current, streaming, loadList, open, create, send, stop } = useChat();
  const kind = useServer((s) => s.view?.state.kind);
  const props = useServerProps();
  const canSend = kind === 'ready' || kind === 'external';
  const convId = id ? Number(id) : null;

  useEffect(() => void loadList(), [loadList]);
  useEffect(() => void open(convId !== null && Number.isInteger(convId) ? convId : null), [convId, open]);

  const onSend = async (text: string) => {
    let target = current?.id;
    if (target === undefined) {
      target = await create();
      navigate(`/chat/${target}`, { replace: true });
    }
    await send(text);
  };

  const serving = props?.model_path ? stem(props.model_path) : null;
  const started = current?.modelPath ? stem(current.modelPath) : null;
  return (
    <div className="grid h-[calc(100dvh-5.5rem)] grid-cols-[13rem_minmax(0,1fr)] gap-4">
      <aside className={cn(GLASS, 'flex min-h-0 flex-col p-2')}>
        <ConversationList
          onNew={() => void create().then((n) => navigate(`/chat/${n}`))}
          onDeleted={(d) => d === convId && navigate('/chat', { replace: true })}
        />
      </aside>

      <section className={cn(GLASS, 'flex min-h-0 flex-col gap-2 p-4')}>
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{current?.title ?? 'Chat'}</h1>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {started ?? serving ?? 'No model loaded'}
              {started && serving && started !== serving && (
                <span className="ml-2 font-sans">— the server now serves {serving}</span>
              )}
            </p>
          </div>
          <div className="flex items-start gap-3">
            <ContextGauge props={props} />
            {current && (
              <Sheet>
                <SheetTrigger render={<Button variant="secondary" size="sm" />}>
                  <SlidersHorizontal /> Settings
                </SheetTrigger>
                <SheetContent className="overflow-y-auto">
                  <SheetHeader>
                    <SheetTitle>Conversation settings</SheetTitle>
                    <SheetDescription>Applied from the next reply.</SheetDescription>
                  </SheetHeader>
                  <div className="px-4 pb-4">
                    <SamplingPanel props={props} />
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </header>
        <Thread canSend={canSend} />
        <Composer
          canSend={canSend}
          streaming={streaming !== null && streaming.conversationId === current?.id}
          onSend={(t) => void onSend(t)}
          onStop={() => void stop()}
        />
      </section>
    </div>
  );
}
