import { availableParallelism } from 'node:os';
import type { Config } from '@react-router/dev/config';

export default {
  appDirectory: 'src',
  basename: '/llama-webui/',
  ssr: false,
  prerender: {
    paths: ({ getStaticPaths }) => getStaticPaths().filter((p) => p !== '*'),
    concurrency: Math.floor(availableParallelism() / 2),
  },
} satisfies Config;
