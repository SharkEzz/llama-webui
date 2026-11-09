import type { Config } from '@react-router/dev/config';

export default {
  appDirectory: 'src',
  basename: '/llama-webui/',
  ssr: false,
  prerender: true,
} satisfies Config;
