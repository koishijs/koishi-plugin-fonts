import { createRequire } from 'module'
import { resolve, dirname } from 'path'
import { pathToFileURL } from 'url'

import { Context, h, Service } from 'koishi'
import type { ElementHandle, Page } from 'puppeteer-core'
import type { Fonts } from 'koishi-plugin-fonts'

import type {} from '@koishijs/canvas'
import type {} from 'koishi-plugin-puppeteer'

export const name = 'fonts4pptr'

export const inject = {
  required: ['fonts', 'puppeteer'],
}

declare module 'koishi' {
  interface Context {
    fonts4pptr: Fonts4Pptr
  }
}

// Augment puppeteer and canvas with the enhanced method signatures
// that fonts4pptr provides at runtime via decoration.
declare module 'koishi-plugin-puppeteer' {
  interface Puppeteer {
    page(options?: {
      beforeGotoPage?: (page: any) => Promise<void>
      url?: string
      gotoOptions?: any
      content?: string
      families?: string[]
    }): Promise<Page>
    render(content: string, families?: string[], callback?: any): Promise<string>
  }
}

declare module '@koishijs/canvas' {
  interface CanvasService {
    createCanvas(
      width: number,
      height: number,
      options?: { families?: string[]; text?: string },
    ): Promise<Canvas>
    render(
      width: number,
      height: number,
      callback: (ctx: CanvasRenderingContext2D<any, any>) => any,
      options?: { families?: string[]; text?: string },
    ): Promise<any>
  }
}

export interface InjectResult {
  dispose: () => Promise<void>
}

class Fonts4Pptr extends Service {
  static [Service.provide] = 'fonts4pptr'

  private _originalPage: any
  private _originalPptrRender: any
  private _originalCreateCanvas: any
  private _originalCanvasRender: any

  constructor(ctx: Context) {
    super(ctx, 'fonts4pptr')
  }

  async start() {
    this.ctx.inject(['fonts', 'puppeteer', 'canvas'], (c) => {
      const puppeteer = c.puppeteer
      const fonts = c.fonts

      // ── Replace puppeteer.page ──
      // The original page() is just `() => this.browser.newPage()`.
      // We provide the full enhanced page() with navigation, content, and fonts.
      this._originalPage = puppeteer.page
      const _page = this._originalPage
      puppeteer.page = async function (options?: {
        beforeGotoPage?: (page: any) => Promise<void>
        url?: string
        gotoOptions?: any
        content?: string
        families?: string[]
      }) {
        let page
        try {
          page = await _page.call(puppeteer)

          if (options) {
            if (options.beforeGotoPage) {
              await options.beforeGotoPage(page)
            }
            if (options.url) {
              await page.goto(pathToFileURL(options.url).href, options.gotoOptions)
            }
            if (options.content) {
              await page.setContent(options.content)
            }
            if (options.families?.length) {
              await injectToPage(page, fonts, options.families)
              await page.addStyleTag({
                content: `* {font-family: ${options.families.map((f) => `'${f}'`).join(', ')};}`,
              })
              await page.evaluate(async () => {
                await document.fonts.ready
                await new Promise(resolve => setTimeout(resolve, 100))
              })
            }
          }
        } catch (err) {
          if (page) await page.close()
          throw err
        }

        return page
      } as typeof puppeteer.page

      // ── Replace puppeteer.render ──
      // The original render (clean, no families) is replaced entirely.
      // fonts4pptr provides the full render with families support.
      // Font injection + CSS + fonts.ready is handled by the page decorator above.
      this._originalPptrRender = puppeteer.render.bind(puppeteer)
      const _require: NodeJS.Require = (() => {
        try { return createRequire(import.meta.url) } catch { return require }
      })()
      const puppeteerDir = dirname(_require.resolve('koishi-plugin-puppeteer/package.json'))
      const indexHtmlUrl = pathToFileURL(resolve(puppeteerDir, 'index.html')).href

      puppeteer.render = async function (content: string, families?: string[], callback?: any) {
        const page = await (puppeteer as any).page({ url: indexHtmlUrl, content, families })

        callback ||= async (_: any, next: any) => page.$('body').then(next)
        const output = await callback(page, async (handle: any) => {
          const clip = handle ? await handle.boundingBox() : null
          const buffer = await page.screenshot({ clip }) as Buffer
          return h.image(buffer, 'image/png').toString()
        })

        page.close()
        return output
      } as any as typeof puppeteer.render

      // ── Decorate canvas ──
      // The puppeteer canvas stores its persistent page as a private field.
      // At runtime we can access it to inject fonts per canvas element.
      const canvas = c.canvas as any
      this._originalCreateCanvas = canvas.createCanvas.bind(canvas)
      const _createCanvas = this._originalCreateCanvas
      canvas.createCanvas = async (
        width: number,
        height: number,
        options?: { families?: string[]; text?: string },
      ) => {
        const page = canvas.page
        let injectResult: InjectResult | undefined

        if (options?.families?.length && page) {
          injectResult = await injectToPage(page, fonts, options.families)
          if (options?.text) {
            await page.evaluate(
              async (text: string, families: string[]) => {
                await document.fonts.load(`1px ${families.join(',')}`, text)
              },
              options.text,
              options.families,
            )
          }
        }

        const el = await _createCanvas(width, height)

        if (injectResult) {
          const _dispose = el.dispose.bind(el)
          el.dispose = async () => {
            await injectResult!.dispose()
            await _dispose()
          }
        }

        return el
      }

      this._originalCanvasRender = canvas.render.bind(canvas)
      const _canvasRender = this._originalCanvasRender
      canvas.render = async (
        width: number,
        height: number,
        callback: (ctx: any) => any,
        options?: { families?: string[]; text?: string },
      ) => {
        const page = canvas.page
        let injectResult: InjectResult | undefined

        if (options?.families?.length && page) {
          injectResult = await injectToPage(page, fonts, options.families)
          if (options?.text) {
            await page.evaluate(
              async (text: string, families: string[]) => {
                await document.fonts.load(`1px ${families.join(',')}`, text)
              },
              options.text,
              options.families,
            )
          }
        }

        try {
          return await _canvasRender(width, height, callback)
        } finally {
          await injectResult?.dispose()
        }
      }
      this.ctx.logger.info('fonts4pptr: decorated puppeteer and canvas with font injection')
    })
  }

  async stop() {
    const puppeteer = this.ctx.get('puppeteer')
    if (this._originalPage) {
      puppeteer.page = this._originalPage
      this._originalPage = null
    }
    if (this._originalPptrRender) {
      puppeteer.render = this._originalPptrRender
      this._originalPptrRender = null
    }

    const canvas = this.ctx.get('canvas')
    if (this._originalCreateCanvas) {
      canvas.createCanvas = this._originalCreateCanvas
      this._originalCreateCanvas = null
    }
    if (this._originalCanvasRender) {
      canvas.render = this._originalCanvasRender
      this._originalCanvasRender = null
    }
  }

  /**
   * Inject fonts into an existing Puppeteer page.
   * Returns an {@link InjectResult} with a `dispose()` method
   * to clean up injected fonts. Call `dispose()` when the fonts
   * are no longer needed (e.g., on a persistent page like canvas).
   */
  async injectToPage(page: Page, families: string[]): Promise<InjectResult> {
    return injectToPage(page, this.ctx.fonts, families)
  }
}

/**
 * Inject font faces into a Puppeteer page.
 *
 * For Google Fonts, adds a `<style>` tag with `@import`.
 * For local fonts (woff/woff2/ttf/otf), creates `FontFace` objects
 * and adds them to `document.fonts`.
 *
 * Returns an {@link InjectResult} whose `dispose()` method
 * removes injected style tags and clears font faces from the page.
 */
export async function injectToPage(page: Page, fonts: Fonts, families: string[]): Promise<InjectResult> {
  const fontData = await fonts.get(families)
  const styleHandles: ElementHandle<Element>[] = []

  await Promise.all(fontData.map(async (font) => {
    if (font.format === 'google') {
      const style = await page.addStyleTag({ url: font.path })
      styleHandles.push(style)
    } else {
      await page.evaluate((font) => {
        const fontFace = new FontFace(
          font.family,
          `url(${font.path}) format('${font.format}')`,
          font.descriptors,
        )
        document.fonts.add(fontFace)
      }, font)
    }
  }))

  return {
    dispose: async () => {
      await Promise.all(styleHandles.map(handle =>
        handle.evaluate(node => node.remove())
          .then(() => handle.dispose())
          .catch(() => {}),
      ))
    },
  }
}

export function apply(ctx: Context) {
  ctx.plugin(Fonts4Pptr)
}

export default Fonts4Pptr
