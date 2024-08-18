import { createHash } from 'crypto'
import { createWriteStream, rmSync } from 'fs'
import { mkdir, rename } from 'fs/promises'
import { resolve } from 'path'
import { Readable, Transform } from 'stream'
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
    ctx.console.addListener('fonts/download', async (name, urls) => {
      const handle = {
        name,
        files: urls.map((url) => ({ url, contentLength: 0, downloaded: 0, cancel: false, cancelled: false })),
      }
      this.downloads[name] = handle
      this.fonts.download(name, urls, handle)
      await this.refresh(true)
      const timer = setInterval(async () => {
        await this.refresh(true)
        if (handle.files.every((file) => file.contentLength > 0 && file.downloaded === file.contentLength)) {
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

  async download(name: string, urls: string[], handle: FontsProvider.Download) {
    const paths = await Promise.all(urls.map((url, index) => this.downloadOne(name, url, handle.files[index]))).catch((err) => { this.ctx.logger.error(err) })
    /*
     * const size = handle.files.reduce((sum, file) => sum + file.contentLength, 0)
     * const time = new Date()
     */
    this.ctx.logger.info(paths)
    // const row = await this.ctx.model.get('fonts', { name })
    /*
     * if (row.length) {
     *   await this.ctx.model.set('fonts', { name }, { paths: [...row[0].paths, ...paths], size: row[0].size + size, updatedTime: time })
     * }
     * else {
     *   await this.ctx.model.create('fonts', { name, paths, size, createdTime: time, updatedTime: time })
     * }
     */
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
    const tempFilePath = resolve(this.root, sanitize(name) + `.${Date.now()}.tmp`)
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
    // TODO: remove temp codes after testing
    let throttle = null
    const readable = Readable.fromWeb(data)
    if (process.env.NODE_ENV === 'development') {
      throttle = new Throttle(1)
      readable.pipe(throttle).pipe(hash)
      readable.pipe(throttle).pipe(output)
    } else {
      readable.pipe(hash)
      readable.pipe(output)
    }

    return await new Promise<string>((_resolve, reject) => {
      const cleanup = () => {
        if (process.env.NODE_ENV === 'development') {
          throttle.unpipe(output)
          throttle.unpipe(hash)
          readable.unpipe(throttle)
        } else {
          readable.unpipe(output)
          readable.unpipe(hash)
        }
        if (process.env.NODE_ENV === 'development') {
          this.ctx.logger.info('clean pipe')
        }
        output.removeAllListeners()
        hash.removeAllListeners()
        if (process.env.NODE_ENV === 'development') {
          throttle.removeAllListeners()
        }
        readable.removeAllListeners()
        if (process.env.NODE_ENV === 'development') {
          this.ctx.logger.info('clean listeners')
          this.ctx.logger.info('clean stream start')
        }

        if (!output.destroyed) {
          // still emit data event after destroy and clear buffer
          output.end(() => {
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('clean output buffer')
            }
            output.destroy()
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('clean output')
            }
            rmSync(tempFilePath)
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('rm file', tempFilePath)
            }
          })
        }
        if (!hash.destroyed) {
          hash.end(() => {
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('clean hash buffer')
            }
            hash.destroy()
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('clean hash')
            }
          })
        }
        if (process.env.NODE_ENV === 'development') {
          if (!throttle.destroyed) {
            while (throttle.read() !== null) {
              this.ctx.logger.info('clear throttle buffer')
            }
            throttle.destroy()
            this.ctx.logger.info('clean throttle')
          }
        }
        if (!readable.destroyed) {
          while (readable.read() !== null) {
            if (process.env.NODE_ENV === 'development') {
              this.ctx.logger.info('clear readable buffer')
            }
          }
          readable.destroy()
          if (process.env.NODE_ENV === 'development') {
            this.ctx.logger.info('clean readable')
          }
        }

        controller.abort()
        if (process.env.NODE_ENV === 'development') {
          this.ctx.logger.info('abort controller')
        }

        handle.cancelled = true
        _resolve('')
      }
      readable.on('error', async (err) => {
        cleanup()
        _resolve('')
      })
      readable.pipe(throttle).on('data', async (chunk) => {
        if (handle.cancel) {
          cleanup()
        }
        if (process.env.NODE_ENV === 'development') {
          this.ctx.logger.info('downloading', name, handle.downloaded, chunk.length)
        }
        // update progress
        handle.downloaded += chunk.length
      })
      if (process.env.NODE_ENV === 'development') {
        readable.on('end', () => {
          this.ctx.logger.info('download finish', name)
        })
      }
      hash.on('finish', async () => {
        if (handle.cancel) {
          if (process.env.NODE_ENV === 'development') {
            this.ctx.logger.info('go into finish cancel')
          }
          cleanup()
        }
        const sha256 = hash.read() as string
        const path = resolve(this.root, name + `.${sha256}`)
        this.ctx.logger.info('download finish', name, path)
        await rename(tempFilePath, path)
        _resolve(path)
      })
    })
  }
}

class Throttle extends Transform {
  private rate: number
  private chunkSize: number
  private lastTime: number

  constructor(rate: number) {
    super({ emitClose: false })
    this.rate = rate // bytes per second
    this.chunkSize = rate / 10 // bytes per 100ms
    this.lastTime = Date.now()
  }

  _transform(chunk, encoding, callback) {
    const now = Date.now()
    const elapsed = now - this.lastTime

    if (elapsed < 1000) {
      setTimeout(() => {
        this.push(chunk)
        callback()
      }, 1000 - elapsed)
    }
    else {
      this.push(chunk)
      this.lastTime = now
      callback()
    }
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
