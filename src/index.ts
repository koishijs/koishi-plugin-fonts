import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { access, constants, mkdir, rename, rm } from 'fs/promises'
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
    fontFaceSet: FontFace
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
    'fonts/delete'(name: string, fonts: FontFace[]): void
    'fonts/download'(name: string, url: string[]): void
    'fonts/cancel'(name: string, url: string[]): void
  }
}

interface Font {
  name: string
  fontFaceSet: string[] | FontFace[]
  size: number
  createdTime: Date
  updatedTime: Date
}

interface FontFace {
  id: string
  fileName: string
  path: string
  size: number
  descriptors?: FontFaceDescriptors
  createdTime?: Date
  updatedTime?: Date
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
    ctx.console.addListener('fonts/delete', async (name, fonts) => {
      await this.fonts.delete(name, fonts)
      await this.refresh(true)
    })
    ctx.console.addListener('fonts/download', async (name, urls) => {
      const handle = {
        name,
        files: urls.map((url) => ({
          url,
          downloaded: 0,
          contentLength: 0,
          finished: false,
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
            .every((file) => file.finished)
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
      downloaded: number
      contentLength: number
      finished: boolean
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
        fontFaceSet: { type: 'list', nullable: false },
        size: { type: 'unsigned', nullable: false },
        createdTime: { type: 'timestamp', nullable: false },
        updatedTime: { type: 'timestamp', nullable: false },
      },
      {
        primary: 'name',
      })
    ctx.model.extend(
      'fontFaceSet',
      {
        'id': { type: 'string', nullable: false },
        'fileName': { type: 'string', nullable: false },
        'path': { type: 'string', nullable: false },
        'size': { type: 'unsigned', nullable: false },
        'descriptors.ascentOverride': { type: 'string' },
        'descriptors.descentOverride': { type: 'string' },
        'descriptors.display': { type: 'string' },
        'descriptors.featureSettings': { type: 'string' },
        'descriptors.lineGapOverride': { type: 'string' },
        'descriptors.stretch': { type: 'string' },
        'descriptors.style': { type: 'string' },
        'descriptors.unicodeRange': { type: 'text' },
        'descriptors.weight': { type: 'string' },
        'createdTime': { type: 'timestamp', nullable: false },
        'updatedTime': { type: 'timestamp', nullable: false },
      },
      {
        primary: 'id',
      },
    )
    ctx.plugin(FontsProvider, this)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
  }

  async list(): Promise<Font[]> {
    const fonts = await this.ctx.model.get('fonts', {})
    for (let i = 0; i < fonts.length; i++) {
      fonts[i].fontFaceSet = await this.ctx.model.get('fontFaceSet', fonts[i].fontFaceSet as string[])
    }
    return fonts
  }

  register(name: string, paths: string[]) {
    this.ctx.logger.info('register', name, paths)
  }

  async delete(name: string, fonts: FontFace[]) {
    this.ctx.logger.info('delete', name, fonts)
    const row = await this.ctx.model.get('fonts', { name })
    if (!row.length) return
    const fontIdSet = new Set(row[0].fontFaceSet as string[])
    this.ctx.logger.info('delete', name, fontIdSet)

    const deleteFontSet = fonts.filter((font) => fontIdSet.has(font.id))
    const deleteFontIdSet = deleteFontSet.map((font) => font.id)
    await Promise.all(deleteFontIdSet.map((id) => this.ctx.model.remove('fontFaceSet', { id })))
    await Promise.all(deleteFontSet.map(async (font) => {
      try {
        await access(font.path, constants.F_OK)
        row[0].size -= font.size
        await rm(font.path)
      }
      catch (err) {
        console.warn(`Failed to delete font file: ${font.path}`, err.message)
      }
    }))

    const fontSet = row[0].fontFaceSet
      .filter((id: string) => !deleteFontIdSet.includes(id)) as string[]
    if (fontSet.length) {
      await this.ctx.model.set('fonts', { name }, { fontFaceSet: fontSet, size: row[0].size, updatedTime: new Date() })
    }
    else {
      await this.ctx.model.remove('fonts', { name })
    }
  }

  async download(name: string, urls: string[], handle: FontsProvider.Download) {
    const downloads =
      await Promise.allSettled(urls.map((url, index) => this.downloadOne(name, url, handle.files[index])))
    const fonts =
      downloads.filter((result) => result.status === 'fulfilled').map((result) => result.value as FontFace)
    if (fonts.length === 0) return

    const size = fonts.reduce((sum, font) => sum + font.size, 0)

    // TODO: parse font descriptors by using fontkit
    for (let i = 0; i < fonts.length; i++) {
      const font = fonts[i]
      fonts[i] = await this.ctx.model.create('fontFaceSet', {
        ...font,
        createdTime: new Date(),
        updatedTime: new Date(),
      })
    }
    const row = await this.ctx.model.get('fonts', { name })
    if (row.length) {
      await this.ctx.model.set(
        'fonts',
        { name },
        {
          fontFaceSet: [...row[0].fontFaceSet as string[], ...fonts.map((font) => font.id)],
          size: row[0].size + size,
          updatedTime: new Date(),
        },
      )
    }
    else {
      await this.ctx.model.create(
        'fonts',
        {
          name, fontFaceSet: fonts.map((font) => font.id),
          size,
          createdTime: new Date(),
          updatedTime: new Date(),
        },
      )
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
  async downloadOne(
    name: string,
    url: string,
    handle: FontsProvider.Download['files'][number],
  ): Promise<FontFace | void> {
    this.ctx.logger.info('download', name, url)
    const controller = new AbortController()
    const { signal } = controller
    const { data, headers } = await this.ctx.http<ReadableStream>(url, { responseType: 'stream', signal })
    const hash = createHash('sha256', { emitClose: false }).setEncoding('hex')
    const folderName = sanitize(name)
    await mkdir(resolve(this.root, folderName), { recursive: true })

    const length = parseInt(headers.get('content-length'))
    handle.contentLength = length ? length : 0

    // resolve file name from headers.
    const contentDisposition = headers.get('content-disposition')
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="(.+)"/)
      if (match) name = match[1]
    }
    else {
      name = basename(url)
    }
    const tempFilePath = resolve(this.root, folderName, name + `.${Date.now()}.tmp`)
    const output = createWriteStream(tempFilePath)

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

    return await new Promise<FontFace | void>((_resolve, _reject) => {
      const cleanup = async () => {
        readable.unpipe(output)
        readable.unpipe(hash)

        output.removeAllListeners()
        hash.removeAllListeners()
        readable.removeAllListeners()

        if (!output.destroyed) {
          // still emit data event after destroy and clear buffer
          output.end(async () => {
            output.destroy()
            await rm(tempFilePath)
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
        _reject(handle.failure ? new Error('download failure') : new Error('download cancelled'))
      }

      readable.on('error', async (err) => {
        handle.failure = true
        await cleanup()
      })

      readable.on('data', async (chunk) => {
        if (handle.cancel) {
          await cleanup()
        }
        handle.downloaded += chunk.length
      })

      /**
       * TODO: handle same file
      */
      hash.on('finish', async () => {
        if (handle.cancel) {
          await cleanup()
        }
        const sha256 = hash.read() as string
        const path = resolve(this.root, folderName, name)
        try {
          await rename(tempFilePath, path)
        }
        catch (err) {
          this.ctx.logger.warn('Wait for system cache', err.message)
          setTimeout(() => {}, 100)
          await rename(tempFilePath, path)
        }
        this.ctx.logger.info('download finish', name, sha256, path)
        handle.finished = true
        _resolve({
          id: crypto.randomUUID().replace('-', ''),
          fileName: name,
          path,
          size: handle.downloaded,
        })
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
