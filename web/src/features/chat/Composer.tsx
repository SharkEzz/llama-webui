import { useState } from "react"
import { Link } from "react-router"
import { ArrowUp, Square } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface ComposerProps {
  canSend: boolean
  streaming: boolean
  onSend(text: string): void
  onStop(): void
}

/** Zone de saisie : Entrée envoie, Maj+Entrée va à la ligne ; Arrêter pendant une réponse. */
export function Composer({ canSend, streaming, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("")
  const submit = () => {
    if (!canSend || streaming || !text.trim()) return
    onSend(text)
    setText("")
  }
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      {!canSend && (
        <Alert>
          <AlertDescription>
            <p>
              llama-server n'est pas prêt : démarrez un profil depuis la page{" "}
              <Link to="/server" className="underline underline-offset-4">
                Serveur
              </Link>{" "}
              pour discuter.
            </p>
          </AlertDescription>
        </Alert>
      )}
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Votre message (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
          disabled={!canSend}
          aria-label="Message"
          className="max-h-60 min-h-12 resize-none bg-card pr-14 backdrop-blur-(--surface-blur)"
        />
        <div className="absolute right-2 bottom-2">
          {streaming ? (
            <Button size="icon-sm" variant="secondary" aria-label="Arrêter la réponse" onClick={onStop}>
              <Square />
            </Button>
          ) : (
            <Button size="icon-sm" aria-label="Envoyer" disabled={!canSend || !text.trim()} onClick={submit}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
