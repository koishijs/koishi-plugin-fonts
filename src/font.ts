import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { access, constants, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { basename, resolve } from 'path'
import { Readable } from 'stream'
import { ReadableStream } from 'stream/web'
import { pathToFileURL } from 'url'

import { $, Context, Service, z } from 'koishi'
import sanitize from 'sanitize-filename'

import { Provider } from './provider'
import { googleFontsParser, mergeFonts } from './utils'

export class Fonts extends Service {
  private root: string
  // TODO: thread safety
  private fonts: Fonts.Font[]

  private formats = ['.woff', '.woff2', '.ttf', '.otf', '.sfnt', '.ttc']

  constructor(ctx: Context, public config: Fonts.Config) {
    super(ctx, 'fonts')
    ctx.model.extend(
      'fonts',
      {
        'id': { type: 'string', length: 64, nullable: false },
        'family': { type: 'string', length: 64, nullable: false },
        'format': { type: 'string', nullable: false },
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
      })
    ctx.plugin(Provider, this)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
    this.fonts = []
  }

  async list(): Promise<Fonts.Font[]> {
    return await this.ctx.model.get('fonts', {})
  }

  async get(families: string[]): Promise<Fonts.Font[]> {
    const db = await this.ctx.model
      .select('fonts')
      .where((row) => $.in(row.family, families))
      .execute()
    const fonts = this.fonts.filter((font) => families.includes(font.family))
    return mergeFonts(fonts, db)
      .map((f) => {
        const font = { ...f }
        font.path = font.format === 'google' ? font.path : `${pathToFileURL(font.path)}`
        font.descriptors = Object.entries(font.descriptors).reduce((acc, [key, value]) => {
          if (value !== null) {
            acc[key] = value
          }
          return acc
        }, {} as FontFaceDescriptors)
        return font
      })
  }

  register: Fonts.Register = async (...args: Fonts.RegisterArgs) => {
    const fonts = Array.isArray(args[0]) ? args[0] : []

    if (!Array.isArray(args[0])) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [family, param, config] = args
      const paths: string[] = Array.isArray(param) ? param : []

      if (!Array.isArray(param)) {
        const isDirectory = async (path: string): Promise<boolean> => {
          try {
            await access(path, constants.F_OK)
            return (await stat(path)).isDirectory()
          }
          catch (err) {
            this.ctx.logger.error(`Failed to access path: ${path}`, err.message)
            return false
          }
        }
        const readAllFiles = async (folderPath: string) => {
          const readFolder = async (path: string) => {
            const entries = await readdir(path, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = resolve(path, entry.name)
              if (entry.isDirectory()) {
                await readFolder(fullPath)
              }
              else {
                paths.push(fullPath)
              }
            }
          }
          await readFolder(folderPath)
        }
        if (await isDirectory(param)) {
          await readAllFiles(param)
          this.ctx.logger.info('scanned %d files from folder: %s', paths.length, param)
        }
      }

      // TODO: parse font descriptors by using fontkit
      fonts.push(...(await Promise.all(
        paths
          .filter((path) =>
            this.formats.some((ext) => path.endsWith(`.${ext}`)))
          .map(async (path) => {
            const sha256 = createHash('sha256')
            const fileStat = await stat(path)
            const fileStream = createReadStream(path)
            const fileName = basename(path)
            // TODO: Verify the validity of the extension name.
            const format = fileName.split('.').pop() as Fonts.Font['format']

            await new Promise<void>((resolve, reject) => {
              fileStream
                .on('data', (chunk) => sha256.update(chunk))
                .on('end', resolve)
                .on('error', reject)
            })

            return {
              id: sha256.digest('hex'),
              family,
              format,
              fileName,
              size: fileStat.size,
              path: path,
              descriptors: {} as FontFaceDescriptors,
            }
          }),
      )))
    }

    this.fonts = mergeFonts(this.fonts, fonts)
    this.ctx.logger.info('registed %d fonts', fonts.length)
  }

  googleFontRegister(url: string) {
    let fonts: Fonts.Font[]
    if (url.startsWith('https://fonts.googleapis.com/css')) {
      fonts = googleFontsParser(url)
      this.fonts = mergeFonts(this.fonts, fonts)
    } else {
      this.ctx.logger.warn('Invalid Google Fonts URL:', url)
    }
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
      await this.ctx.model.upsert(
        'fonts',
        Array.isArray(font) ? font : [{
          ...font,
          family,
        }],
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
  private async downloadOne(
    name: string,
    url: string,
    handle: Provider.Download['files'][number],
  ): Promise<Fonts.Font[] | Fonts.Font | void> {
    this.ctx.logger.info('download', name, url)
    // 检查 URL 是否为 Google Fonts 的 URL
    if (url.startsWith('https://fonts.googleapis.com/css')) {
      return googleFontsParser(url)
    }

    const family = name
    const controller = new AbortController()
    const { signal } = controller
    const { data, headers } = await this.ctx.http<ReadableStream>(url, { responseType: 'stream', signal })
    const hash = createHash('sha256', { emitClose: false })
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
    let format: Fonts.Font['format']
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
          format = 'woff'
        }
        else if (contentType.includes('font/woff2')) {
          name += '.woff2'
          format = 'woff2'
        }
        else if (contentType.includes('font/ttf')) {
          name += '.ttf'
          format = 'ttf'
        }
        else if (contentType.includes('font/otf')) {
          name += '.otf'
          format = 'otf'
        }
        else if (contentType.includes('font/sfnt')) {
          name += '.sfnt'
          format = 'sfnt'
        }
        else if (contentType.includes('font/collection')) {
          name += '.ttc'
          format = 'ttc'
        }
        else {
          this.ctx.logger.warn('unknown font type', contentType)
        }
      }
    }
    else {
      const ext = name.split('.').pop()
      if (this.formats.includes(ext)) {
        format = ext
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
      output.on('finish', async () => {
        if (handle.cancel) {
          await cleanup()
          return
        }

        const sha256 = hash.digest('hex')
        const path = resolve(this.root, folderName, name)
        let retry = 3
        let success = false

        try {
          while (retry--) {
            try {
              await rename(tempFilePath, path)
              success = true
              break
            }
            catch (err) {
              if (retry) {
                this.ctx.logger.warn(`Retrying ${3 - retry} times to rename file failed: ${err.message}`)
                await new Promise((resolve) =>
                  setTimeout(resolve, 100 * Math.pow(2, 3 - retry)))
              }
              else {
                throw new Error(`Failed to rename file after retrying 3 times: ${err.message}`)
              }
            }
          }
        }
        finally {
          if (!success) {
            this.ctx.logger.warn('Cleaning up temporary file due to failure.')
            await rm(tempFilePath).catch((err) => {
              this.ctx.logger.error(`Failed to remove temporary file: ${err.message}`)
            })
            handle.failure = true
            await cleanup()
          }
          else {
            this.ctx.logger.info('Download finished successfully', name, sha256, path)
            handle.finished = true
            _resolve({
              id: sha256,
              family,
              format,
              fileName: name,
              path,
              size: handle.downloaded,
            })
          }
        }
      })
    })
  }
}

export namespace Fonts {
  export interface Font {
    id: string
    family: string
    format: string
    fileName: string
    size: number
    path: string
    descriptors?: FontFaceDescriptors
  }

  export type RegisterArgs = [string, string | string[], Fonts.RegisterConfig?] | [Fonts.Font[]]

  export interface RegisterConfig {
    parse?: boolean
    descriptors?: FontFaceDescriptors
  }

  export interface Register {

    (family: string, folderPath: string, config?: RegisterConfig): Promise<void>
    (family: string, paths: string[], config?: RegisterConfig): Promise<void>
    (fonts: Font[]): Promise<void>
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
