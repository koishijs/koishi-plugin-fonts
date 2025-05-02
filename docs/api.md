# API

## 类型

### Font
```ts
interface Font {
    id: string
    family: string
    format: FontFormat
    fileName: string
    size: number
    path: string
    descriptors?: FontFaceDescriptors
  }
```

### FontFormats
```ts
type FontFormat = typeof FontFormats[keyof typeof FontFormats]

const FontFormats = {
  WEB_OPEN_FONT_FORMAT: 'woff',
  WEB_OPEN_FONT_FORMAT_2: 'woff2',
  TRUE_TYPE_FONT: 'ttf',
  OPEN_TYPE_FONT: 'otf',
  SPLINE_FONT: 'sfnt',
  TRUE_TYPE_COLLECTION: 'ttc',
  GOOGLE_FONT: 'google',
  MANIFEST: 'manifest',
} as const

```

### FontManifest
```ts
interface FontManifest {
  version: string
  fonts: {
    [fontFamily: string]: FontManifestSource[]
  }
  options?: FontManifestOptions
}

```

### FontManifestSource
```ts
type FontManifestSource = GoogleFontManifestSource | LocalOrRemoteFontManifestSource

interface BaseFontManifestSource {
  type: FontSourceType
  options?: FontManifestOptions
}

interface GoogleFontManifestSource extends BaseFontManifestSource {
  type: 'google'
  urls: string[]
}

interface LocalOrRemoteFontManifestSource extends BaseFontManifestSource {
  type: 'local' | 'remote'
  slice: Font[]
}

```

### FontSourceTypes
```ts
type FontSourceType = typeof FontSourceTypes[keyof typeof FontSourceTypes]

const FontSourceTypes = {
  LOCAL: 'local',
  REMOTE: 'remote',
  GOOGLE: 'google',
} as const

```

### FontManifestOptions
```ts
interface FontManifestOptions {
  getSha256?: boolean
}
```

### RegisterConfig
```ts
interface RegisterConfig {
  descriptors?: FontFaceDescriptors
}
```

## 方法

### clear(sourceName)
- sourceName: `string` 来源插件名
- 返回值: `Promise<void>`

清除插件所注册的字体

### get(families)
- families: `string[]` 字体名
- 返回值: `Promise<Font[]>` 字体数组

获取指定字体

### googleFontRegister(url, sourceName)
- url: `string | string[]` Google Fonts URL
- sourceName: `string` 来源插件名
- 返回值: `Promise<void>`

注册 Google Fonts 字体

### manifestRegister(path, sourceName)
- path: `string | string[]` Manifest 文件路径
- sourceName: `string` 来源插件名
- 返回值: `Promise<void>`

通过 Manifest 文件注册字体

### register(...RegisterArgs)
```ts
register(fonts, sourceName)
register(family, folderPath, sourceName, config?)
register(family, paths, sourceName, config?)
```
- fonts: [`Font[]`](#font) 字体数组
- family: `string` 字体名
- folderPath: `string` 文件夹路径
- paths: `string[]` 文件路径数组
- sourceName: `string` 来源插件名
- config: [`RegisterConfig`](#registerconfig) 字体注册时的选项及配置
  - config.descriptors: [`FontFaceDescriptors`](https://developer.mozilla.org/en-US/docs/Web/API/FontFace/FontFace#descriptors) 字体描述符
- 返回值: `Promise<void>`

注册字体
