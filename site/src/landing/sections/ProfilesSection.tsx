import { Boxes, Home, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { BentoCard, FeatureSection, SHOT_FRAME } from '../Bento';
import { Shot } from '../Shot';
import { ArgsEditorDemo } from './ArgsEditorDemo';

export function ProfilesSection() {
  return (
    <FeatureSection
      id="profiles"
      tone="rose"
      pages={[
        { label: 'Models', icon: Boxes },
        { label: 'Profiles', icon: SlidersHorizontal },
        { label: 'Home', icon: Home },
        { label: 'Chat', icon: MessageSquare },
      ]}
      title="From a GGUF file to a conversation."
      lede="Download a model from Hugging Face, save how to run it in a profile, start it from Home and chat with it, without leaving the tab."
    >
      <BentoCard
        className="lg:col-span-3"
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

      <BentoCard className="lg:col-span-3" title="Arguments with autocompletion" visual={<ArgsEditorDemo />}>
        A profile keeps the model, a projector, arguments and environment. The editor suggests flags and their help from
        your own llama-server --help.
      </BentoCard>

      <BentoCard
        className="lg:col-span-3"
        title="Start in one click"
        visual={
          <Shot
            name="launchpad"
            alt="Launch pad: three profiles with their model, quantization, last benchmark and memory fit, each with a Start or Switch button"
            crop={{ x: 0.155, y: 0.07, w: 0.445, h: 0.3 }}
            width="min(36rem, 90vw)"
            className={SHOT_FRAME}
          />
        }
      >
        The launch pad on Home lists every profile with its last benchmark and whether it fits, then starts or switches
        llama-server.
      </BentoCard>

      <BentoCard
        className="lg:col-span-3"
        title="Chat with numbers"
        visual={
          <Shot
            name="chat-stats"
            alt="End of a chat answer with code, followed by its stats: time to first token, prompt and generation speed, tokens and MTP acceptance"
            crop={{ x: 0.335, y: 0.79, w: 0.42, h: 0.19 }}
            width="min(36rem, 90vw)"
            className={SHOT_FRAME}
          />
        }
      >
        Streaming Markdown and code, reasoning you can fold, and under every answer: time to first token, speeds and
        draft acceptance. Generation keeps going if you leave the page.
      </BentoCard>
    </FeatureSection>
  );
}
