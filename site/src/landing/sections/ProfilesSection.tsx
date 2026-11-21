import { Boxes, MessageSquare, Server, SlidersHorizontal } from 'lucide-react';
import { Shot } from '@/components/Shot';
import { BentoCard, FeatureSection, SHOT_FRAME } from '../Bento';
import { ArgsEditorDemo } from './ArgsEditorDemo';

export function ProfilesSection() {
  return (
    <FeatureSection
      id="profiles"
      tone="rose"
      pages={[
        { label: 'Models', icon: Boxes, doc: '/docs/models/' },
        { label: 'Profiles', icon: SlidersHorizontal, doc: '/docs/profiles/' },
        { label: 'Server', icon: Server, doc: '/docs/server/' },
        { label: 'Chat', icon: MessageSquare, doc: '/docs/chat/' },
      ]}
      title="From a GGUF file to a conversation."
      lede="Download a model from Hugging Face, save how to run it in a profile, start llama-server and chat with it, without leaving the tab."
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <BentoCard
          tone="rose"
          title="Download from Hugging Face"
          visual={
            <Shot
              name="models-hf"
              alt="Hugging Face download sheet: the quantizations of a repository, each with its size and a Fits in VRAM badge"
              crop={{ x: 0.64, y: 0.005, w: 0.36 }}
              width="min(36rem, 90vw)"
              fade
              className={`${SHOT_FRAME} min-h-96 flex-1`}
            />
          }
        >
          Search the Hub, pick a quantization: a badge says whether it fits in your VRAM. Downloads are checked with
          sha256 and resume after a network error or a restart.
        </BentoCard>

        <BentoCard tone="rose" title="Arguments with autocompletion" visual={<ArgsEditorDemo />}>
          A profile keeps the model, a projector, arguments and environment. The editor suggests flags and their help
          from your own llama-server --help.
        </BentoCard>

        <BentoCard
          tone="rose"
          title="Start and switch llama-server"
          visual={
            <Shot
              name="server"
              alt="Server page: profile selector, Start, Restart and Stop controls, effective llama-server command and live status"
              crop={{ x: 0.155, y: 0.07, w: 0.835, h: 0.48 }}
              width="min(36rem, 90vw)"
              className={SHOT_FRAME}
            />
          }
        >
          Pick a profile, start, stop or switch llama-server cleanly, and inspect the exact effective command and
          capabilities reported by /props.
        </BentoCard>

        <BentoCard
          tone="rose"
          title="Chat with numbers"
          visual={
            <Shot
              name="chat-stats"
              alt="End of a chat answer with code, followed by its stats: time to first token, prompt and generation speed, tokens and draft acceptance"
              crop={{ x: 0.335, y: 0.79, w: 0.42, h: 0.19 }}
              width="min(36rem, 90vw)"
              className={SHOT_FRAME}
            />
          }
        >
          Streaming Markdown and code, reasoning you can fold, and under every answer: time to first token, speeds and
          draft acceptance. Generation keeps going if you leave the page.
        </BentoCard>
      </div>
    </FeatureSection>
  );
}
