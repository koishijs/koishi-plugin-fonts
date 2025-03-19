import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { access, constants, mkdir, rename, rm } from 'fs/promises'
import { basename, resolve } from 'path'
import { Readable } from 'stream'
import { ReadableStream } from 'stream/web'
import { pathToFileURL } from 'url'

import { $, Context, Service, z } from 'koishi'
import sanitize from 'sanitize-filename'

import { Provider } from './provider'

export class Fonts extends Service {
  private root: string

  constructor(ctx: Context, public config: Fonts.Config) {
    super(ctx, 'fonts')
    ctx.model.extend(
      'fonts',
      {
        'id': { type: 'unsigned', nullable: false },
        'family': { type: 'string', length: 50, nullable: false },
        'fileName': { type: 'string', nullable: false },
        'size': { type: 'unsigned', nullable: false },
        'path': { type: 'string', nullable: false },
        'descriptors.ascentOverride': { type: 'string' },
        'descriptors.descentOverride': { type: 'string' },
        'descriptors.display': { type: 'string' },
        'descriptors.featureSettings': { type: 'string' },
        'descriptors.lineGapOverride': { type: 'string' },
        'descriptors.stretch': { type: 'string' },
        'descriptors.style': { type: 'string' },
        'descriptors.unicodeRange': { type: 'text' },
        'descriptors.weight': { type: 'string' },
      },
      {
        primary: 'id',
        autoInc: true,
      })
    ctx.plugin(Provider, this)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
    this.ctx.logger.info(this.root)
  }

  async list(): Promise<Fonts.Font[]> {
    return await this.ctx.model.get('fonts', {})
  }

  async get(families: string[]) {
    return (await this.ctx.model
      .select('fonts')
      .where((row) => $.in(row.family, families))
      .execute())
      .map((f) => {
        const font = { ...f }
        font.path = `${pathToFileURL(font.path)}`
        font.descriptors = Object.entries(font.descriptors).reduce((acc, [key, value]) => {
          if (value !== null) {
            acc[key] = value
          }
          return acc
        }, {} as FontFaceDescriptors)
        return font
      })
  }

  register(name: string, paths: string[]) {
    this.ctx.logger.info('register', name, paths)
  }

  async delete(family: string, fonts: Fonts.Font[]) {
    const row = await this.ctx.model.get('fonts', { family })
    if (!row.length) return

    const rowFontIds = new Set(row.map((rowFont) => rowFont.id))
    const deleteFont = fonts.filter((font) => rowFontIds.has(font.id))
    await Promise.all(deleteFont.map((f) => this.ctx.model.remove('fonts', f)))
    await Promise.all(deleteFont.map(async (f) => {
      try {
        await access(f.path, constants.F_OK)
        await rm(f.path)
      }
      catch (err) {
        console.warn(`Failed to delete file: ${f.path}`, err.message)
      }
    }))
  }

  async download(family: string, urls: string[], handle: Provider.Download) {
    const downloads =
      await Promise.allSettled(urls.map((url, index) => this.downloadOne(family, url, handle.files[index])))
    const fonts =
      downloads.filter((result) => result.status === 'fulfilled').map((result) => result.value as Fonts.Font)
    if (fonts.length === 0) return

    // TODO: parse font descriptors by using fontkit
    for (let i = 0; i < fonts.length; i++) {
      const font = fonts[i]
      await this.ctx.model.create(
        'fonts',
        {
          ...font,
          family,
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
  protected async downloadOne(
    name: string,
    url: string,
    handle: Provider.Download['files'][number],
  ): Promise<Fonts.Font | void> {
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

    return await new Promise<Fonts.Font | void>((_resolve, _reject) => {
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
          fileName: name,
          path,
          size: handle.downloaded,
        })
      })
    })
  }
}

export namespace Fonts {
  export interface Font {
    id?: number
    family?: string
    fileName: string
    size: number
    path: string
    descriptors?: FontFaceDescriptors
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

  export interface Config {
    root: string
  }
}

export { Provider }
