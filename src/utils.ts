import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import type { Fonts } from './font'

/**
 * Merge font lists, update existing fonts and return new fonts
 * @param existingFonts
 * @param newFonts
 * @returns List of merged fonts
 */
export function mergeFonts(existingFonts: Fonts.Font[], newFonts: Fonts.Font[]): Fonts.Font[] {
  const unique = newFonts.filter((font) =>
    !existingFonts.some((f) => f.id === font.id)
  )
  const update = existingFonts.map((exist) =>
    newFonts.find((font) => font.id === exist.id) || exist
  )
  return [...update, ...unique]
}

/**
 * Parse the Google Fonts URL, separating each font
 * @param u Google Fonts 的 URL
 * @returns List of fonts
 */
export function googleFontsParser(u: string): Fonts.Font[] {
  const result: Fonts.Font[] = []
  const url = new URL(u)
  const queryParams = url.searchParams
  const families = queryParams.getAll('family')
  const display = queryParams.get('display') as FontDisplay

  families.forEach((family) => {
    const [name, variants] = family.split(':')
    const font: Fonts.Font = {
      id: family,
      family: decodeURIComponent(name),
      format: 'google',
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

export async function getFileSha256(path: string): Promise<string> {
  const sha256 = createHash('sha256')
  const fileStream = createReadStream(path)
  await new Promise<void>((resolve, reject) => {
    fileStream
      .on('data', (chunk) => sha256.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })

  return sha256.digest('hex')
}
