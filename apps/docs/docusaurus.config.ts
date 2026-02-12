import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import searchLocalPlugin from '@easyops-cn/docusaurus-search-local';

const config: Config = {
  title: 'Brainstrike Docs',
  tagline: 'Local-first architecture and implementation docs',
  favicon: 'img/favicon.svg',

  url: 'https://docs.brainstrike.ai',
  baseUrl: '/',

  organizationName: 'brainstrike-ai',
  projectName: 'brainstrike-docs',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  themes: ['@docusaurus/theme-mermaid'],

  plugins: [
    [
      searchLocalPlugin,
      {
        docsRouteBasePath: '/',
        indexBlog: false,
        indexDocs: true,
        hashed: true,
        language: ['en'],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        pages: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/architecture/brainstrike-architecture-hero.png',
    navbar: {
      title: 'Brainstrike Docs',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/brainstrike-ai/brainstrike',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Architecture',
          items: [
            { label: 'System Context', to: '/' },
            { label: 'Embedding Pipeline', to: '/architecture/embedding-pipeline' },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Brainstrike`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
