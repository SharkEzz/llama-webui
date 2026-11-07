import { ArrowUp, Square } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ComposerProps {
  canSend: boolean;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
}

/** Input box: Enter sends, Shift+Enter adds a new line; Stop during a reply. */
export function Composer({ canSend, streaming, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!canSend || streaming || !text.trim()) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      {!canSend && (
        <Alert>
          <AlertDescription>
            <p>
              llama-server is not ready: start a profile from the{' '}
              <Link to="/server" className="underline underline-offset-4">
                Server
              </Link>{' '}
              page to chat.
            </p>
          </AlertDescription>
        </Alert>
      )}
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Your message (Enter to send, Shift+Enter for a new line)"
          disabled={!canSend}
          aria-label="Message"
          className="max-h-60 min-h-12 resize-none bg-card pr-14 backdrop-blur-(--surface-blur)"
        />
        <div className="absolute right-2 bottom-2">
          {streaming ? (
            <Button size="icon-sm" variant="secondary" aria-label="Stop the reply" onClick={onStop}>
              <Square />
            </Button>
          ) : (
            <Button size="icon-sm" aria-label="Send" disabled={!canSend || !text.trim()} onClick={submit}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
