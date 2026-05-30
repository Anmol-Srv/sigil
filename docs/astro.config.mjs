import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://anmol-srv.github.io',
  base: '/sigil',
  integrations: [
    starlight({
      title: 'Sigil',
      description:
        'Local-first memory infrastructure for AI coding agents. One brain shared across Claude Code, Codex CLI, Cursor, Kiro, and more — stored in your own Postgres.',
      logo: {
        src: './src/assets/sigil.svg',
        alt: 'Sigil',
        replacesTitle: false,
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'script',
          content: "document.documentElement.setAttribute('data-theme','dark')",
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Anmol-Srv/sigil',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Quickstart', link: '/quickstart/' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { label: 'Claude Code', link: '/integrations/claude-code/' },
            { label: 'Cursor', link: '/integrations/cursor/' },
            { label: 'Kiro', link: '/integrations/kiro/' },
            { label: 'Codex CLI', link: '/integrations/codex-cli/' },
            { label: 'Continue', link: '/integrations/continue/' },
            { label: 'Cline', link: '/integrations/cline/' },
            { label: 'Windsurf', link: '/integrations/windsurf/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How it works', link: '/concepts/how-it-works/' },
            { label: 'Pods', link: '/concepts/pods/' },
            { label: 'Hybrid Search', link: '/concepts/search/' },
            { label: 'Memory Decay', link: '/concepts/memory-decay/' },
          ],
        },
      ],
      expressiveCode: {
        styleOverrides: {
          borderRadius: '2px',
        },
      },
    }),
  ],
});
