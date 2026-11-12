/** Site-wide constants. Internal paths are given without the /llama-webui basename (React Router adds it). */
export const SITE = {
  name: 'llama-webui',
  tagline: "A local control room for llama.cpp's llama-server.",
  description:
    'Launch models, watch every GPU in real time, chat, benchmark, and find the best offload settings for your hardware, all from one browser tab served by a single Node.js process.',
  url: 'https://sharkezz.github.io/llama-webui',
  repo: 'https://github.com/SharkEzz/llama-webui',
  llamaCpp: 'https://github.com/ggml-org/llama.cpp',
} as const;

export const NAV_LINKS = [
  { label: 'Docs', to: '/docs/' },
  { label: 'Developers', to: '/developers/' },
] as const;
