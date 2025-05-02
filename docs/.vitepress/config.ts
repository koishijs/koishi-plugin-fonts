import { defineConfig } from '@cordisjs/vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Koishi Font Manager',
  description: 'Koishi 的字体管理器',

  head: [
    ['link', { rel: 'icon', href: 'https://koishi.chat/logo.png' }],
    ['link', { rel: 'manifest', href: 'https://koishi.chat/manifest.json' }],
    ['meta', { name: 'theme-color', content: '#5546a3' }],
  ],

  themeConfig: {
    indexName: 'koishi-plugin-fonts',

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '关于', link: '/' },
          { text: '配置', link: '/config' },
          { text: '使用', link: '/usage'},
          { text: 'API', link: '/api'},
        ],
      },
      {
        text: '更多',
        items: [{ text: 'Koishi 官网', link: 'https://koishi.chat' }],
      },
    ],

    socialLinks: {
      discord: 'https://discord.com/invite/xfxYwmd284',
      github: 'https://github.com/koishijs/koishi-plugin-fonts',
    },

    footer: {
      message: `Released under the MIT License.`,
      copyright: 'Copyright © 2024-present SaarChaffee',
    },

    editLink: {
      text: '在 GitHub 上编辑此页',
      pattern: 'https://github.com/koishijs/koishi-plugin-fonts/edit/master/docs/:path',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    outline: {
      label: '目录',
      level: 'deep',
    }
  },
})
