import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rename } from 'fs/promises'
import { resolve } from 'path'
import { Readable } from 'stream'
import { ReadableStream } from 'stream/web'

import { DataService } from '@koishijs/console'
import { Context, Service, z } from 'koishi'
import sanitize from 'sanitize-filename'

declare module 'koishi' {
  interface Context {
    fonts: Fonts
  }

  interface Tables {
    fonts: Font[]
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      fonts: FontsProvider
    }
  }

  interface Events {
    'fonts/register'(name: string, paths: string[]): void
    'fonts/download'(name: string, url: string[]): void
    'fonts/cancel'(name: string): boolean
  }
}

interface Font {
  name: string
  paths: string[]
  size: number
  createdTime: Date
  updatedTime: Date
}

class FontsProvider extends DataService<FontsProvider.Payload> {
  downloads: Record<string, FontsProvider.Download> = {}

  constructor(ctx: Context, private fonts: Fonts) {
    super(ctx, 'fonts')

    ctx.console.addEntry(
      process.env.KOISHI_BASE
        ? [process.env.KOISHI_BASE + '/dist/index.js', process.env.KOISHI_BASE + '/dist/style.css']
        : {
          dev: resolve(__dirname, '../client/index.ts'),
          prod: resolve(__dirname, '../dist'),
        },
    )

    ctx.console.addListener('fonts/register', this.fonts.register)
    ctx.console.addListener('fonts/download', async (name, urls) => {
      const handle = {
        name,
        files: urls.map((url) => ({ url, contentLength: 0, downloaded: 0 })),
      }
      this.downloads[name] = handle
      this.fonts.download(name, urls, handle)
      await this.refresh(true)
      const timer = setInterval(async () => {
        await this.refresh(true)
        if (handle.files.every((file) => file.contentLength > 0 && file.downloaded === file.contentLength)) {
          clearInterval(timer)
          delete this.downloads[name]
        }
      }, 1000)
    })
  }

  async get(): Promise<FontsProvider.Payload> {
    return {
      downloads: this.downloads,
      fonts: await this.fonts.list(),
    }
  }
}

namespace FontsProvider {
  export interface Download {
    name: string
    files: {
      url: string
      contentLength: number
      downloaded: number
    }[]
  }

  export interface Payload {
    fonts: Font[]
    downloads?: Record<string, Download>
  }
}

class Fonts extends Service {
  static inject = ['database']

  private root: string

  constructor(ctx: Context, public config: Fonts.Config) {
    super(ctx, 'fonts', true)
    ctx.plugin(FontsProvider, this)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
  }

  async list(): Promise<Font[]> {
    return []
  }

  register(name: string, paths: string[]) {
    this.ctx.logger.info('register', name, paths)
  }

  async download(name: string, urls: string[], handle: FontsProvider.Download) {
    return await Promise.all(urls.map((url, index) => this.downloadOne(name, url, handle.files[index])))
  }

  /**
   * @param name the name of the font to be displayed
   * @param url the url of the font to be downloaded
   * @param handle the download handle
   *
   * @returns the sha256 hash of the downloaded file
   *
   * Download a font from the given URL and save it to the `data/fonts` directory.
   * The file name will be appended with the hash of the file content.
   */
  async downloadOne(name: string, url: string, handle: FontsProvider.Download['files'][number]) {
    this.ctx.logger.info('download', name, url)
    const { data, headers } = await this.ctx.http<ReadableStream>(url, { responseType: 'stream' })
    const hash = createHash('sha256').setEncoding('hex')
    const tempFilePath = resolve(this.root, sanitize(name) + `.${Date.now()}.tmp`)
    const output = createWriteStream(tempFilePath)

    const length = headers['content-length']
    if (length) {
      handle.contentLength = +length
    }

    // resolve file name from headers.
    const contentDisposition = headers['content-disposition']
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="(.+)"/)
      if (match) name = match[1]
    }

    // in case the filename didn't contains the extension,
    // resolve file type from header.
    if (!name.includes('.')) {
      const contentType = headers['content-type']
      if (contentType) {
        if (contentType.includes('font/woff')) {
          name += '.woff'
        } else if (contentType.includes('font/woff2')) {
          name += '.woff2'
        } else if (contentType.includes('font/ttf')) {
          name += '.ttf'
        } else if (contentType.includes('font/otf')) {
          name += '.otf'
        } else if (contentType.includes('font/sfnt')) {
          name += '.sfnt'
        } else if (contentType.includes('font/collection')) {
          name += '.ttc'
        } else {
          this.ctx.logger.warn('unknown font type', contentType)
        }
      }
    }

    const readable = Readable.fromWeb(data)
    readable.pipe(hash)
    readable.pipe(output)

    await new Promise<string>((_resolve, reject) => {
      readable.on('error', reject)
      output.on('data', (chunk) => {
        // update progress
        handle.downloaded += chunk.length
      })
      hash.on('finish', async () => {
        const sha256 = hash.read() as string
        await rename(tempFilePath, resolve(this.root, name + `.${sha256}`))
        _resolve(sha256)
      })
    })
  }
}

namespace Fonts {
  export interface Config {
    root: string
  }

  export const Config: z<Config> = z.object({
    root: z
      .path({
        filters: ['directory'],
        allowCreate: true,
      })
      .default('data/fonts')
      .description('存放字体的目录。'),
  })
}

export default Fonts
