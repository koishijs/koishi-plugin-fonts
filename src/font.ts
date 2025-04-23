import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { access, constants, mkdir, readdir, readFile, rename, rm, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'path'
import { Readable } from 'stream'
import { ReadableStream } from 'stream/web'
import { pathToFileURL } from 'url'

import { $, Context, Service, z } from 'koishi'
import sanitize from 'sanitize-filename'

import { Provider } from './provider'
import {
  getFileInfo,
  getFileSha256,
  isFontManifest,
  isUrl,
  mergeFonts,
  ReadWriteLock,
} from './utils'

export class Fonts extends Service {
  private root: string
  private lock: ReadWriteLock
  private fonts: Fonts.Font[]

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
    this.lock = new ReadWriteLock(true)
  }

  async start() {
    this.root = resolve(this.ctx.baseDir, this.config.root)
    await mkdir(this.root, { recursive: true })
    await this.lock.withWriteLock(() => {
      this.fonts = []
    })
    const manifest = await this.ctx.model.get('fonts', { format: 'manifest' })
    if (manifest.length) {
      this.ctx.logger.info('found %d manifest fonts in database', manifest.length)
      await this.manifestRegister(manifest.map((m) => m.path))
    }
  }

  /**
   * Retrieves a list of fonts from the database.
   *
   * @returns A promise that resolves to an array of font objects.
   */
  async list(): Promise<Fonts.Font[]> {
    return await this.ctx.model.get('fonts', {})
  }

  /**
   * Retrieves a list of fonts based on the specified font families.
   *
   * This method waits for any pending write operations to complete before
   * acquiring a read lock to safely access the font data. It fetches font
   * information from both the in-memory font list and the database, then
   * merges the results.
   *
   * @param families - An array of font family names to retrieve.
   * @returns A promise that resolves to an array of `Fonts.Font` objects
   *          containing the merged font data.
   */
  async get(families: string[]): Promise<Fonts.Font[]> {
    await this.lock.waitForWritesToComplete()
    return await this.lock.withReadLock(async () => {
      const db = await this.ctx.model
        .select('fonts')
        .where((row) => $.in(row.family, families))
        .execute()
      const fonts = this.fonts.filter((font) => families.includes(font.family))

      return mergeFonts(fonts, db)
        .map((f) => {
          const font = { ...f }
          font.path = font.format === 'google' || isUrl(font.path)
            ? font.path
            : `${pathToFileURL(font.path)}`
          font.descriptors = Object.entries(font.descriptors).reduce((acc, [key, value]) => {
            if (value !== null) {
              acc[key] = value
            }
            return acc
          }, {} as FontFaceDescriptors)
          return font
        })
    })
  }

  /**
   * Registers fonts into the system. This function supports registering fonts
   * from an array of font descriptors or by scanning a directory for font files.
   * It ensures thread safety by using a write lock during the registration process.
   *
   * @param args: {@link Fonts.Register}
   *             - The arguments for font registration. It can either be an array
   *               of font descriptors or a tuple containing the font family name,
   *               a path (or array of paths) to font files or directories, and
   *               an optional configuration object.
   */
  register: Fonts.Register = async (...args: Fonts.RegisterArgs) => {
    return await this.lock.withWriteLock(async () => {
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
              Object.values(Fonts.FontFormats).some((ext) => path.endsWith(`.${ext}`)))
            .map(async (path) => {
              const { id, size } = await getFileInfo(path)
              const fileName = basename(path)
              const format = fileName.split('.').pop() as Fonts.FontFormat

              return {
                id: id || fileName,
                family,
                format,
                fileName,
                size,
                path: path,
                descriptors: {} as FontFaceDescriptors,
              }
            }),
        )))
      }

      this.fonts = mergeFonts(this.fonts, fonts)
      this.ctx.logger.info('registed %d fonts', fonts.length)
    })
  }

  /**
   * Registers Google Fonts by processing URLs from the Google Fonts API.
   *
   * This method parses font information from provided Google Fonts URLs and
   * registers them into the font system. It uses a write lock to ensure thread safety
   * during the registration process.
   *
   * @param param - A single Google Fonts URL string or an array of URL strings
   *
   */
  googleFontRegister: Fonts.GoogleFontRegister = (param: string | string[]) => {
    return this.lock.withWriteLock(() => {
      let fonts: Fonts.Font[]
      (Array.isArray(param) ? param : [param]).forEach((url) => {
        if (url.startsWith('https://fonts.googleapis.com/css')) {
          fonts = this.googleFontsParser(url)
        }
        else {
          this.ctx.logger.warn('Invalid Google Fonts URL:', url)
        }
      })
      this.fonts = mergeFonts(this.fonts, fonts)
      this.ctx.logger.info('registed %d google fonts', fonts.length)
    })
  }

  /**
   * Parse the Google Fonts URL, separating each font
   * @param u Google Fonts 的 URL
   * @returns List of fonts
   */
  googleFontsParser(u: string): Fonts.Font[] {
    const result: Fonts.Font[] = []
    const url = new URL(u)
    const queryParams = url.searchParams
    const families = queryParams.getAll('family')
    const display = queryParams.get('display') as FontDisplay

    families.forEach((family) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [name, variants] = family.split(':')
      const font: Fonts.Font = {
        id: family,
        family: decodeURIComponent(name),
        format: Fonts.FontFormats.GOOGLE_FONT,
        fileName: family,
        size: 0, // 大小未知
        path: `${url.origin}${url.pathname}?family=${family}${display ? `&display=${display}` : ''}`
          .replace(' ', '+'),
        descriptors: {} as FontFaceDescriptors,
      }
      result.push(font)
    })

    return result
  }

  manifestRegister: Fonts.ManifestRegister = async (param: string | string[]) => {
    const paths = Array.isArray(param) ? param : [param]
    for (const path of paths) {
      await this.manifestParser(path)
    }
  }

  private async manifestParser(path: string, downloadFont?: boolean) {
    let jsonContent: string
    let base: string
    let isRemote = false

    if (isUrl(path)) {
      try {
        this.ctx.logger.info('Fetching remote manifest:', path)
        jsonContent = await this.ctx.http.get<string>(path, { responseType: 'text' })
        const url = new URL(path)
        base = url.href.substring(0, url.href.lastIndexOf('/') + 1)
        isRemote = true
      }
      catch (err) {
        this.ctx.logger.error(`Failed to fetch remote manifest: ${path}`, err)
        return
      }
    }
    else {
      try {
        jsonContent = await readFile(path, 'utf8')
        base = dirname(path)
      }
      catch (err) {
        this.ctx.logger.error(`Failed to read local manifest: ${path}`, err)
        return
      }
    }

    let json
    try {
      json = JSON.parse(jsonContent)
    }
    catch (err) {
      this.ctx.logger.error(`Failed to parse JSON from ${path}:`, err)
      return
    }

    if (!isFontManifest(json)) {
      this.ctx.logger.warn('Invalid manifest format:', path)
      return
    }

    this.ctx.logger.info(`Parsing ${isRemote ? 'remote' : 'local'} manifest from: ${path}`)
    const manifest = json as Fonts.FontManifest
    const options = manifest.options || {}
    const families = Object.keys(manifest.fonts)

    for (const family of families) {
      const sources = manifest.fonts[family]

      for (const source of sources) {
        const sourceOptions = { ...options, ...source?.options }

        switch (source.type) {
          case Fonts.FontSourceTypes.LOCAL:
          case Fonts.FontSourceTypes.REMOTE:
            source.slice = await Promise.all(source.slice.map(async (font) => {
              if (!isAbsolute(font.path) && !isUrl(font.path)) {
                if (isRemote) {
                  font.path = new URL(font.path, base).href
                }
                else {
                  font.path = resolve(base, font.path)
                }
              }

              if (
                (sourceOptions?.getSha256 || downloadFont) &&
                source.type === Fonts.FontSourceTypes.LOCAL &&
                !isUrl(font.path)
              ) {
                const { id, size } = await getFileInfo(font.path)
                font.id = id
                font.size = size
              }
              font.family = family
              return font
            }))

            if (downloadFont) {
              switch (source.type) {
                case Fonts.FontSourceTypes.REMOTE: {
                  const handle = {
                    name: family,
                    files: source.slice.map((font) => ({
                      url: font.path,
                      downloaded: 0,
                      contentLength: 0,
                      finished: false,
                      cancel: false,
                      cancelled: false,
                      failure: false,
                    })),
                  }
                  await this.download(handle)
                  break
                }
                case Fonts.FontSourceTypes.LOCAL: {
                  await this.ctx.model.upsert(
                    'fonts',
                    source.slice,
                  )
                }
              }
            }
            else {
              await this.register(source.slice)
              this.ctx.logger.debug(`Processed ${source.type} fonts for family: ${family}`)
            }
            break

          case Fonts.FontSourceTypes.GOOGLE:
            if (downloadFont) {
              const handle = {
                name: family,
                files: source.urls.map((url) => ({
                  url,
                  downloaded: 0,
                  contentLength: 0,
                  finished: false,
                  cancel: false,
                  cancelled: false,
                  failure: false,
                })),
              }
              await this.download(handle)
            }
            else {
              await this.googleFontRegister(source.urls)
              this.ctx.logger.debug(`Processed Google fonts for family: ${family}`)
            }
            break
        }
      }
    }
  }

  /**
   * Deletes font entries from the database and removes their corresponding files from the filesystem.
   *
   * @param family - The font family name to identify the fonts to delete.
   * @param fonts - An array of font objects containing details about the fonts to be deleted.
   *
   * @throws Will not throw an error if a file cannot be accessed or deleted, but logs a warning instead.
   */
  async delete(family: string, fonts: Fonts.Font[]) {
    const row = await this.ctx.model.get('fonts', { family })
    if (!row.length) return

    const rowFontIds = new Set(row.map((rowFont) => rowFont.id))
    const deleteFont = fonts.filter((font) => rowFontIds.has(font.id))
    await Promise.all(deleteFont.map((f) => this.ctx.model.remove('fonts', f)))
    await Promise.all(deleteFont.map(async (f) => {
      if (Object.values(Fonts.FontFormats).includes(f.format) && !isUrl(f.path)) {
        try {
          await access(f.path, constants.F_OK)
          await rm(f.path)
        }
        catch (err) {
          console.warn(`Failed to delete file: ${f.path}`, err.message)
        }
      }
    }))
  }

  private async deleteExist(path: string) {
    const sha256 = await getFileSha256(path)
    await this.ctx.model.remove('fonts', { id: sha256 })
    await rm(path)
  }

  /**
   * Downloads font files from the provided URLs, processes them, and updates the database with the font information.
   *
   * @param family - The font family name to associate with the downloaded fonts.
   * @param handle - A provider-specific download handler containing file metadata.
   *
   * @returns A promise that resolves when the font data has been processed and stored.
   */
  async download(handle: Provider.Download) {
    const downloads =
      await Promise.allSettled(handle.files.map((file, index) => {
        const url = file.url
        if (url.startsWith('https://fonts.googleapis.com/css')) {
          handle.files[index].finished = true
          return this.googleFontsParser(url)
        }
        if (url.endsWith('/fonts.json')) {
          handle.files[index].finished = true
          return this.manifestParser(url, true)
        }
        return this.downloadOne(handle.name, handle.files[index])
      }))
    const fonts = downloads
      .filter((result) => result.status === 'fulfilled')
      .filter(Boolean)
      .map((result) => result.value as Fonts.Font)
    if (fonts.length === 0) return

    // TODO: parse font descriptors by using fontkit
    for (let i = 0; i < fonts.length; i++) {
      const font = fonts[i]
      await this.ctx.model.upsert(
        'fonts',
        Array.isArray(font)
          ? font
          : [{
              ...font,
              family: handle.name,
            }],
      )
    }
  }

  /**
   * @param name the name of the font to be displayed
   * @param handle the download handle
   *
   * @returns the sha256 hash of the downloaded file
   *
   * Download a font from the given URL and save it to the `data/fonts` directory.
   * The file name will be appended with the hash of the file content.
   */
  private async downloadOne(
    name: string,
    handle: Provider.Download['files'][number],
  ): Promise<Fonts.Font[] | Fonts.Font | void> {
    const url = handle.url
    if (!url.trim()) {
      handle.failure = true
      throw new Error(`Empty URL provided: ${name}`)
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
    let ext
    if (name.includes('.')) {
      ext = name.split('.').pop()
    }
    if (ext && Object.values(Fonts.FontFormats).includes(ext)) {
      format = ext
    }
    else {
      const contentType = headers.get('content-type')
      switch (contentType) {
        case 'font/woff': {
          name += `.${Fonts.FontFormats.WEB_OPEN_FONT_FORMAT}`
          format = Fonts.FontFormats.WEB_OPEN_FONT_FORMAT
          break
        }
        case 'font/woff2': {
          name += `.${Fonts.FontFormats.WEB_OPEN_FONT_FORMAT_2}`
          format = Fonts.FontFormats.WEB_OPEN_FONT_FORMAT_2
          break
        }
        case 'font/ttf': {
          name += `.${Fonts.FontFormats.TRUE_TYPE_FONT}`
          format = Fonts.FontFormats.TRUE_TYPE_FONT
          break
        }
        case 'font/otf': {
          name += `.${Fonts.FontFormats.OPEN_TYPE_FONT}`
          format = Fonts.FontFormats.OPEN_TYPE_FONT
          break
        }
        case 'font/sfnt': {
          name += `.${Fonts.FontFormats.SPLINE_FONT}`
          format = Fonts.FontFormats.SPLINE_FONT
          break
        }
        case 'font/collection': {
          name += `.${Fonts.FontFormats.TRUE_TYPE_COLLECTION}`
          format = Fonts.FontFormats.TRUE_TYPE_COLLECTION
          break
        }
        default: {
          this.ctx.logger.warn('unknown font type', contentType)
          try {
            if (await access(tempFilePath, constants.F_OK).then(() => true).catch(() => false)) {
              await rm(tempFilePath)
            }
          }
          catch (err) {
            this.ctx.logger.error(`Failed to remove temporary file: ${err.message}`)
          }
          handle.failure = true
          return Promise.reject(new Error(`Unknown font type of file: ${name}`))
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

      output.on('finish', async () => {
        if (handle.cancel) {
          await cleanup()
          return
        }

        const sha256 = hash.digest('hex')
        const path = resolve(this.root, folderName, name)
        let retry = 3
        let success = false

        if (await access(path, constants.F_OK).then(() => true).catch(() => false)) {
          await this.deleteExist(path)
        }

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
    format: FontFormat
    fileName: string
    size: number
    path: string
    descriptors?: FontFaceDescriptors
  }

  export const FontFormats = {
    WEB_OPEN_FONT_FORMAT: 'woff',
    WEB_OPEN_FONT_FORMAT_2: 'woff2',
    TRUE_TYPE_FONT: 'ttf',
    OPEN_TYPE_FONT: 'otf',
    SPLINE_FONT: 'sfnt',
    TRUE_TYPE_COLLECTION: 'ttc',
    GOOGLE_FONT: 'google',
    MANIFEST: 'manifest',
  } as const

  export type FontFormat = typeof FontFormats[keyof typeof FontFormats]

  export interface FontManifest {
    version: string
    fonts: {
      [fontFamily: string]: FontManifestSource[]
    }
    options?: FontManifestOptions
  }

  export interface BaseFontManifestSource {
    type: FontSourceType
    options?: FontManifestOptions
  }

  export const FontSourceTypes = {
    LOCAL: 'local',
    REMOTE: 'remote',
    GOOGLE: 'google',
  } as const

  export type FontSourceType = typeof FontSourceTypes[keyof typeof FontSourceTypes]

  export interface GoogleFontManifestSource extends BaseFontManifestSource {
    type: 'google'
    urls: string[]
  }

  export interface LocalOrRemoteFontManifestSource extends BaseFontManifestSource {
    type: 'local' | 'remote'
    slice: Font[]
  }

  export type FontManifestSource = GoogleFontManifestSource | LocalOrRemoteFontManifestSource

  export interface FontManifestOptions {
    getSha256?: boolean
  }

  export type RegisterArgs =
    | [fonts: Font[]]
    | [family: string, folderPath: string, config?: RegisterConfig]
    | [family: string, paths: string[], config?: RegisterConfig]

  export interface RegisterConfig {
    parse?: boolean
    descriptors?: FontFaceDescriptors
  }

  export interface Register {

    (family: string, folderPath: string, config?: RegisterConfig): Promise<void>
    (family: string, paths: string[], config?: RegisterConfig): Promise<void>
    (fonts: Font[]): Promise<void>
  }

  export interface GoogleFontRegister {
    (url: string): Promise<void>
    (urls: string[]): Promise<void>
  }

  export interface ManifestRegister {
    (path: string): Promise<void>
    (paths: string[]): Promise<void>
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
