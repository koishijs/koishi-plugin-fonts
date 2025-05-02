# 使用
Fonts 服务提供了管理字体以及使用字体的 API。

## 调用服务
Fonts 插件注册了名为 `fonts` 的服务，可以通过其调用 Fonts 服务。

### 注册字体
提供了以下几种注册方式：
- [`register(family, folderPath, sourceName, config?)`](../api#register)
- [`register(family, paths, sourceName, config?)`](../api#register)
- [`register(fonts, sourceName)`](../api#register)
- [`googleFontRegister(url, sourceName)`](../api#googlefontregister)
- [`manifestRegister(path, sourceName)`](../api#manifestregister)

```ts
import { Context, Schema } from 'koishi'

import type {} from 'koishi-plugin-fonts'
import { resolve } from 'path'

export const name = 'plugin name'

export interface Config {}

export const inject = ['fonts']

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  // 注册字体
  ctx.fonts.googleFontRegister('https://fonts.googleapis.com/css2?family=xxxxxx',
    'plugin name')

  ctx.fonts.register('family name', [
    'https://net/path/to/font.woff2',
    '/path/to/file.woff2',
    `${resolve(__dirname, './font/file.woff2')}`,
  ], 'plugin name')

  ctx.fonts.manifestRegister(resolve(__dirname, './fonts.json'), 'plugin name')

  // 当插件卸载时，释放已注册的字体
  ctx.on('dispose', () => {
    ctx.fonts.clear('plugin name')
  })

  // ...你的代码
}

```
其中：
1. 当使用 `register(family, folderPath, sourceName)` 时，会遍历其所有子路径。
2. 当以 Manifest 文件注册字体时，会以其所在路径作为相对路径的基路径，无论是本地字体还是远程字体，都会将相对路径转为绝对路径。因此，请确保使用相对路径时，其可以正确解析为字体文件的绝对路径。

#### Manifest 文件样例

:::tip

Manifest 中的 `type` 字段指定了字体的来源，`google` 表示 Google Fonts，`local` 表示本地字体，`remote` 表示远程字体。在通过[服务调用](#调用服务)时，对字体的处理仅仅是将三种字体注册到 Fonts 服务中，并不会调用内置下载器下载字体文件。但是在控制台中下载一个 Manifest 时，会下载远程字体文件并将其链接替换为本地路径，然后把它与另外两种来源的字体信息一同持久化存储。

:::

```json
{
  "version": "1.0",
  "fonts": {
    "font-family-name": [
      {
        "type": "google",
        "urls": [
          "https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap"
        ]
      },
      {
        "type": "local",
        "options": {
          "getSha256": true
        },
        "slice": [
          {
            "id": "123456",
            "family": "Roboto",
            "format": "woff2",
            "fileName": "Roboto-Regular.woff2",
            "size": 12345,
            "path": "/path/to/font/Roboto-Regular.woff2",
            "descriptors": {
              "weight": "normal",
              "style": "normal",
              "display": "swap",
              "unicodeRange": "U+3000-30FF"
            }
          },
          {
            "id": "123456",
            "family": "Roboto",
            "format": "woff2",
            "fileName": "Roboto-Bold.woff2",
            "size": 12345,
            "path": "./path/to/font/Roboto-Bold.woff2",
            "descriptors": {
              "weight": "bold",
              "style": "normal",
              "display": "swap",
              "unicodeRange": "U+3000-30FF"
            }
          }
        ]
      }
    ]
  }
}
```

### 释放已注册字体
- [`clear(sourceName)`](../api#clear)

虽然卸载插件不释放已经注册的字体没什么大问题，但为了避免维护注册字体的数组无限扩大，建议在插件卸载时释放已注册的字体。


### 使用字体
这里以 [浏览器 (Puppeteer)]([./plugins/puppeteer.md](https://puppeteer.koishi.chat/)) 插件为例，使用其已经集成了 Fonts 服务的 API 来使用字体。

```ts
// ...其他依赖
import type {} from 'koishi-plugin-puppeteer'
import type {} from 'koishi-plugin-canvas'

export const inject = ['puppeteer', 'canvas', 'fonts']

// ...其他代码

export function apply(ctx: Context) {

  // ...注册字体

  // 使用字体渲染
  ctx.command('pptr <text:text>')
    .action(async ({ session }, text) => {
      return await session.app.puppeteer.render(text, ['family name'])
    })

  ctx.command('canvas <text:text>')
    .action(({ session }, text) => {
      return session.app.canvas.render(400, 200, async (ctx) => {
        ctx.fillStyle = 'blue'
        ctx.font = '40px family name'
        ctx.fillText(text, 10, 50)
      }, { families: ['family name'], text }
      )
    })
}
```

#### pptr环境注意事项
1. 对于本地字体，需要使用 `pathToFileURL()` 来转换为 `file://` 协议的 URL，当然这一步 Fonts 插件已经做过了。
2. 字体描述符，即 `descriptors` 中的字段不能为 `null` 或者 `undefined`，否则会导致字体加载失败。
3. v8 加载字体时，其请求头中的 `Rrigin` 会被置为 `null`，所以需要服务器返回的字体带有跨域头 `Access-Control-Allow-Origin: *`。
4. `page.setContent()` 会替换整个页面上下文，要在其调用后再设置字体以及样式。
5. 在页面中使用字体并且是通过样式指定字体时，需要等待字体加载完成后再进行渲染。
6. 要在 `canvas` 中使用字体，需要先在页面上下文中注册好字体。
7. `canvas` 渲染前，需要手动加载字体，这里推荐使用 `document.fonts.load()` 来加载字体，它会自动寻找符合 `unicode range` 的字体文件并加载。当然，你也可以在 `document.fonts.add(fontFace)` 之后就执行 `fontFace.load()` 直接将字体加载好。
