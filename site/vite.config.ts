import { fileURLToPath } from 'node:url';
import mdx from '@mdx-js/rollup';
import { reactRouter } from '@react-router/dev/vite';
import rehypeShiki from '@shikijs/rehype';
import tailwindcss from '@tailwindcss/vite';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { defineConfig } from 'vite';
import { codeMeta, rehypeDocExports, remarkDocFrontmatter } from './src/docs/mdx-plugins.ts';

const contentDir = fileURLToPath(new URL('./content', import.meta.url));

export default defineConfig({
  base: '/llama-webui/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    // MDX first: the React Router plugin parses route modules with Babel, so .mdx must already be JS.
    {
      enforce: 'pre',
      ...mdx({
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [remarkFrontmatter, remarkDocFrontmatter, remarkGfm],
        rehypePlugins: [
          rehypeSlug,
          [rehypeDocExports, { contentDir }],
          [rehypeAutolinkHeadings, { behavior: 'wrap', properties: { className: ['heading-link'] } }],
          [
            rehypeShiki,
            {
              // Same themes as the app's chat (web/src/lib/highlight.ts); app.css picks one from the .dark class.
              themes: { light: 'github-light', dark: 'github-dark' },
              defaultColor: false,
              langs: ['bash', 'shell', 'ini', 'json', 'ts', 'tsx', 'yaml', 'diff', 'sql', 'text'],
              fallbackLanguage: 'text',
              transformers: [codeMeta],
            },
          ],
        ],
      }),
    },
    tailwindcss(),
    reactRouter(),
  ],
});
