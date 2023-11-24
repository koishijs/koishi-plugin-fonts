import { Context, Service, z } from 'koishi'
import { resolve } from 'path'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { finished, Readable } from 'stream'
import { promisify } from 'util'
import { DataService } from '@koishijs/console'

declare module 'koishi' {
  interface Context {
    fonts: Fonts
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
    'fonts/download'(name: string, url: string): void
  }
}

interface Font {
  name: string
  paths: string[]
  size: number
}

class FontsProvider extends DataService<unknown[]> {
  constructor(ctx: Context, private fonts: Fonts) {
    super(ctx, 'fonts')

    ctx.console.addEntry(process.env.KOISHI_BASE ? [
      process.env.KOISHI_BASE + '/dist/index.js',
      process.env.KOISHI_BASE + '/dist/style.css',
    ] : {
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })

    ctx.console.addListener('fonts/register', this.fonts.register)
    ctx.console.addListener('fonts/download', this.fonts.download)
  }

  async get() {
    return await this.fonts.list()
  }
}

class Fonts extends Service {
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
    this.logger.info('register', name, paths)
  }

  async download(name: string, url: string) {
    this.logger.info('download', name, url)
    const stream = await this.ctx.http.get(url, { responseType: 'stream' }) as Readable
    const path = resolve(this.root, name)
    stream.pipe(createWriteStream(path))
    return promisify(finished)(stream)
  }
}

namespace Fonts {
  export interface Config {
    root: string
  }

  export const Config: z<Config> = z.object({
    root: z.path({
      filters: ['directory'],
      allowCreate: true,
    }).default('data/fonts').description('存放字体的目录。'),
  })
}

export default Fonts
