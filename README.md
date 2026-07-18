<h1 align="center">Font Manager for Koishi</h1>

<p align="center">
  Koishi 的字体管理插件
</p>

## 插件列表

| 名称 | 版本 | 描述 |
| :-- | :-- | :-- |
| [fonts](https://github.com/koishijs/koishi-plugin-fonts/tree/main/packages/fonts) | [![NPM](https://img.shields.io/npm/v/koishi-plugin-fonts?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-fonts) | 核心插件，提供字体注册、下载与管理 |
| [fonts4pptr](https://github.com/koishijs/koishi-plugin-fonts/tree/main/packages/fonts4pptr) | [![NPM](https://img.shields.io/npm/v/koishi-plugin-fonts4pptr?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-fonts4pptr) | Puppeteer 适配器，自动为页面和画布注入字体 |

## 安装方式

在插件市场中搜索 `fonts` 或 `fonts4pptr` 安装，或使用包管理器手动安装：

```bash
yarn add koishi-plugin-fonts koishi-plugin-fonts4pptr
```

## 使用方式

### 注册字体

可以通过配置文件、manifest 文件或 API 注册字体。详细说明请参考[文档](https://fonts.koishi.chat)。

```yaml
# koishi.yml
plugins:
  fonts:
    root: data/fonts
```

### puppeteer.page(options?)

加载 `fonts4pptr` 后，`ctx.puppeteer.page()` 将自动获得字体注入能力。

- **options.beforeGotoPage:** `(page: Page) => Promise<void>` 页面跳转前回调，用于设置页面参数
- **options.url:** `string` 页面地址
- **options.gotoOptions:** `GotoOptions` 页面跳转选项
- **options.content:** `string` 要渲染的 HTML
- **options.families:** `string[]` 字体家族名称列表
- 返回值: `Promise<Page>`

```ts
const page = await ctx.puppeteer.page({
  url: resolve(__dirname, 'index.html'),
  content: '<div>Hello World</div>',
  families: ['Noto Sans SC', 'GlowSansSC-Normal'],
})
```

### puppeteer.render(content, families?, callback?)

渲染 HTML 页面为图片，可指定渲染字体。

- **content:** `string` 要渲染的 HTML
- **families:** `string[]` 字体家族名称列表
- **callback:** `(page, next) => Promise<string>` 回调函数
- 返回值: `string`

```ts
const image = await ctx.puppeteer.render(
  '<div style="font-size: 48px">Hello World</div>',
  ['Noto Sans SC'],
)
```

### canvas.createCanvas(width, height, options?)

创建画布并注入字体。

- **width:** `number` 宽度
- **height:** `number` 高度
- **options.families:** `string[]` 字体家族名称列表
- **options.text:** `string` 用于预加载字体的文本
- 返回值: `Promise<Canvas>`

```ts
const canvas = await ctx.canvas.createCanvas(800, 600, {
  families: ['Noto Sans SC', 'GlowSansSC-Normal'],
  text: '预加载文本',
})
const ctx2d = canvas.getContext('2d')
ctx2d.font = '48px "Noto Sans SC"'
ctx2d.fillText('Hello', 10, 100)
const buffer = await canvas.toBuffer('image/png')
```

### 作为插件依赖

以 `ctx.puppeteer` 或 `ctx.canvas` 为基础开发的插件无需直接依赖 `fonts`，只需声明 `fonts4pptr`：

```ts
export const inject = ['puppeteer', 'fonts4pptr']
// 或者
export const inject = ['canvas', 'fonts4pptr']
```

当用户同时安装 `fonts` 和 `fonts4pptr` 后，你的插件调用 `ctx.puppeteer.page({ families: [...] })` 即可自动获得字体支持。

## 许可证

本项目遵循 [MIT](./LICENSE) 协议。
