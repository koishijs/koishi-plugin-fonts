import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { mkdir, rename } from 'fs/promises'
import { basename, resolve } from 'path'
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
    fonts: Font
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
    'fonts/delete'(name: string, paths: string[]): void
    'fonts/download'(name: string, url: string[]): void
    'fonts/cancel'(name: string, url: string[]): void
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
    ctx.console.addListener('fonts/delete', async (name, paths) => {
      await this.fonts.delete(name, paths)
      await this.refresh(true)
    })
    ctx.console.addListener('fonts/download', async (name, urls) => {
      const handle = {
        name,
        files: urls.map((url) => ({
          url,
          contentLength: 0,
          downloaded: 0,
          cancel: false,
          cancelled: false,
          failure: false,
        })),
      }
      this.downloads[name] = handle
      this.fonts.download(name, urls, handle)
      await this.refresh(true)
      const timer = setInterval(async () => {
        await this.refresh(true)

        // TODO: need a bettle handle when some are failure, some are finished
        if (handle.files.every((file) => file.failure)) {
          clearInterval(timer)
          delete this.downloads[name]
          await this.refresh(true)
        }
        if (
          handle.files
            .filter((file) => !file.failure)
            .every((file) => file.contentLength > 0 && file.downloaded === file.contentLength)
        ) {
          clearInterval(timer)
          setTimeout(async () => {
            delete this.downloads[name]
            await this.refresh(true)
          }, 2000)
        }
      }, 1000)
      Object.defineProperty(this.downloads[name], 'timer', { value: timer })
    })
    ctx.console.addListener('fonts/cancel', async (name, urls) => {
      ctx.logger.info('request cancel', name)
      this.downloads[name].files.forEach((file) => {
        if (urls.includes(file.url) || !urls.length) {
          file.cancel = true
        }
      })
      let count = 0
      const timer = setInterval(async () => {
        if (
          this.downloads[name].files
            .filter((file) => urls.includes(file.url) || !urls.length)
            .every((file) => file.cancelled)
        ) {
          ctx.logger.info('cancel success', name)
          clearInterval(timer)
          if (!urls.length) {
            clearInterval(this.downloads[name]['timer'])
            delete this.downloads[name]
          }
          else {
            this.downloads[name].files = this.downloads[name].files
              .filter((file) => !urls.includes(file.url))
          }
          await this.refresh(true)
        }
        else if (count > 5) {
          clearInterval(timer)
        }
        count++
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
      cancel: boolean
      cancelled: boolean
      failure: boolean
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
    ctx.model.extend(
      'fonts',
      {
        name: { type: 'string', length: 50, nullable: false },
        paths: { type: 'list', nullable: false },
        size: { type: 'unsigned', nullable: false },
        createdTime: { type: 'timestamp', nullable: false },
        updatedTime: { type: 'timestamp', nullable: false },
      },
      {
        primary: 'name',
      })
    ctx.plugin(FontsProvider, this)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
  }

  async list(): Promise<Font[]> {
    return await this.ctx.model.get('fonts', {})
  }

  register(name: string, paths: string[]) {
    this.ctx.logger.info('register', name, paths)
  }

  async delete(name: string, paths: string[]) {
    const row = await this.ctx.model.get('fonts', { name })
    if (!row.length) return

    paths.forEach((path) => {
      if (existsSync(path)) {
        rmSync(path)
      }
    })

    const fontPaths = row[0].paths.filter((path) => !paths.includes(path) || !paths.length)
    if (fontPaths.length) {
      await this.ctx.model.set('fonts', { name }, { paths: fontPaths, updatedTime: new Date() })
    }
    else {
      await this.ctx.model.remove('fonts', { name })
    }
  }

  async download(name: string, urls: string[], handle: FontsProvider.Download) {
    const paths = await Promise.all(urls.map((url, index) => this.downloadOne(name, url, handle.files[index])))
    const size = handle.files.reduce((sum, file) => sum + file.contentLength, 0)
    const time = new Date()
    this.ctx.logger.info(paths)
    const row = await this.ctx.model.get('fonts', { name })

    const fontPaths = paths.filter((path) => path.trim().length > 0)
    if (fontPaths.length === 0) return

    if (row.length) {
      await this.ctx.model.set(
        'fonts',
        { name },
        {
          paths: [...row[0].paths, ...paths],
          size: row[0].size + size,
          updatedTime: time,
        },
      )
    }
    else {
      await this.ctx.model.create('fonts', { name, paths, size, createdTime: time, updatedTime: time })
    }
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
    const controller = new AbortController()
    const { signal } = controller
    const { data, headers } = await this.ctx.http<ReadableStream>(url, { responseType: 'stream', signal })
    const hash = createHash('sha256', { emitClose: false }).setEncoding('hex')
    const folderName = sanitize(name)
    mkdirSync(resolve(this.root, folderName), { recursive: true })
    const tempFilePath = resolve(this.root, folderName, folderName + `.${Date.now()}.tmp`)
    const output = createWriteStream(tempFilePath)

    const length = parseInt(headers.get('content-length'))
    if (length) {
      handle.contentLength = length
    }

    // resolve file name from headers.
    const contentDisposition = headers.get('content-disposition')
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="(.+)"/)
      if (match) name = match[1]
    }
    else {
      name = basename(url)
    }

    /*
     * TODO: handle zip 7z rar...
     * in case the filename didn't contains the extension,
     * resolve file type from header.
     */
    if (!name.includes('.')) {
      const contentType = headers['content-type']
      if (contentType) {
        if (contentType.includes('font/woff')) {
          name += '.woff'
        }
        else if (contentType.includes('font/woff2')) {
          name += '.woff2'
        }
        else if (contentType.includes('font/ttf')) {
          name += '.ttf'
        }
        else if (contentType.includes('font/otf')) {
          name += '.otf'
        }
        else if (contentType.includes('font/sfnt')) {
          name += '.sfnt'
        }
        else if (contentType.includes('font/collection')) {
          name += '.ttc'
        }
        else {
          this.ctx.logger.warn('unknown font type', contentType)
        }
      }
    }

    const readable = Readable.fromWeb(data)
    readable.pipe(hash)
    readable.pipe(output)

    return await new Promise<string>((_resolve, reject) => {
      const cleanup = () => {
        readable.unpipe(output)
        readable.unpipe(hash)

        output.removeAllListeners()
        hash.removeAllListeners()
        readable.removeAllListeners()

        if (!output.destroyed) {
          // still emit data event after destroy and clear buffer
          output.end(() => {
            output.destroy()
            rmSync(tempFilePath)
          })
        }
        if (!hash.destroyed) {
          hash.end(() => {
            hash.destroy()
          })
        }

        if (!readable.destroyed) {
          while (readable.read() !== null) {
            continue
          }
          readable.destroy()
        }

        controller.abort()
        handle.cancelled = true
        _resolve('')
      }

      readable.on('error', async (err) => {
        handle.failure = true
        cleanup()
      })

      readable.on('data', async (chunk) => {
        if (handle.cancel) {
          cleanup()
        }
        handle.downloaded += chunk.length
      })

      /**
       * TODO: handle same file
      */
      hash.on('finish', async () => {
        if (handle.cancel) {
          cleanup()
        }
        const sha256 = hash.read() as string
        const path = resolve(this.root, folderName, name)
        await rename(tempFilePath, path)
        this.ctx.logger.info('download finish', name, sha256, path)
        _resolve(path)
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
