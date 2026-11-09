/**
 * Sidebar of both documentation sections, in reading order. Every .mdx file under content/ must appear here exactly
 * once, and every entry must have its file (src/docs/nav.test.ts). Paths are routes: "docs/getting-started/installation"
 * for docs/getting-started/installation.mdx, "docs" for docs/index.mdx.
 */
import type { NavSection } from '../src/docs/nav.ts';

export const NAV: NavSection[] = [
  {
    id: 'docs',
    title: 'Documentation',
    groups: [
      {
        title: 'Getting started',
        pages: [
          { path: 'docs', title: 'Introduction' },
          { path: 'docs/getting-started/requirements', title: 'Requirements' },
          { path: 'docs/getting-started/installation', title: 'Installation' },
          { path: 'docs/getting-started/first-run', title: 'First run' },
          { path: 'docs/getting-started/quick-start', title: 'Quick start' },
        ],
      },
      {
        title: 'Configuration',
        pages: [
          { path: 'docs/configuration', title: 'Launch options' },
          { path: 'docs/settings', title: 'Settings' },
          { path: 'docs/security', title: 'Security' },
        ],
      },
      {
        title: 'Run models',
        pages: [
          { path: 'docs/home', title: 'Home and launch pad' },
          { path: 'docs/models', title: 'Models' },
          { path: 'docs/hugging-face', title: 'Hugging Face downloads' },
          { path: 'docs/profiles', title: 'Profiles' },
          { path: 'docs/server', title: 'Server' },
          { path: 'docs/chat', title: 'Chat' },
        ],
      },
      {
        title: 'Monitor',
        pages: [
          { path: 'docs/dashboard', title: 'Dashboard' },
          { path: 'docs/system', title: 'System' },
          { path: 'docs/topology', title: 'Topology' },
          { path: 'docs/logs', title: 'Logs' },
        ],
      },
      {
        title: 'Measure and tune',
        pages: [
          { path: 'docs/benchmark', title: 'Benchmark' },
          { path: 'docs/tuning', title: 'Tuning' },
          { path: 'docs/sweeps', title: 'Sweeps' },
        ],
      },
      {
        title: 'Guides',
        pages: [
          { path: 'docs/guides/big-moe-models', title: 'Run a 100 GB MoE model' },
          { path: 'docs/guides/mixed-gpus', title: 'Split a model across mixed GPUs' },
          { path: 'docs/guides/find-best-flags', title: 'Find the best flags with a sweep' },
          { path: 'docs/guides/speculative-decoding', title: 'Speculative decoding and MTP' },
          { path: 'docs/guides/dram-bandwidth', title: 'Monitor DRAM bandwidth' },
        ],
      },
      {
        title: 'Help',
        pages: [
          { path: 'docs/troubleshooting', title: 'Troubleshooting' },
          { path: 'docs/faq', title: 'FAQ' },
        ],
      },
    ],
  },
  {
    id: 'developers',
    title: 'Developers',
    groups: [
      {
        title: 'Overview',
        pages: [
          { path: 'developers', title: 'Overview' },
          { path: 'developers/getting-started', title: 'Development setup' },
          { path: 'developers/architecture', title: 'Architecture' },
        ],
      },
      {
        title: 'Server',
        pages: [
          { path: 'developers/server/supervisor', title: 'Supervisor' },
          { path: 'developers/server/monitor', title: 'Monitor and collectors' },
          { path: 'developers/server/chat', title: 'Chat runs' },
          { path: 'developers/server/bench', title: 'Benchmarks and sweeps' },
          { path: 'developers/server/tuning', title: 'Tuning' },
          { path: 'developers/server/hugging-face', title: 'Hugging Face downloads' },
          { path: 'developers/server/database', title: 'Database' },
          { path: 'developers/server/security', title: 'Security' },
        ],
      },
      {
        title: 'Web app and shared code',
        pages: [
          { path: 'developers/frontend', title: 'Web app' },
          { path: 'developers/shared', title: 'Shared package' },
        ],
      },
      {
        title: 'API reference',
        pages: [
          { path: 'developers/api/overview', title: 'Overview' },
          { path: 'developers/api/websocket', title: 'WebSocket' },
          { path: 'developers/api/app', title: 'Health and settings' },
          { path: 'developers/api/setup', title: 'Setup and launch pad' },
          { path: 'developers/api/profiles', title: 'Profiles' },
          { path: 'developers/api/server', title: 'Server, state and logs' },
          { path: 'developers/api/models', title: 'Models' },
          { path: 'developers/api/hf', title: 'Hugging Face' },
          { path: 'developers/api/chat', title: 'Chat' },
          { path: 'developers/api/monitor', title: 'Monitor and system' },
          { path: 'developers/api/topology', title: 'Topology' },
          { path: 'developers/api/bench', title: 'Benchmarks' },
          { path: 'developers/api/sweeps', title: 'Sweeps' },
          { path: 'developers/api/tuning', title: 'Tuning' },
        ],
      },
      {
        title: 'Contributing',
        pages: [
          { path: 'developers/contributing/conventions', title: 'Conventions' },
          { path: 'developers/contributing/testing', title: 'Testing' },
          { path: 'developers/contributing/how-to', title: 'How-to guides' },
          { path: 'developers/contributing/workflow', title: 'Docs, commits and PRs' },
        ],
      },
    ],
  },
];
