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

export class ReadWriteLock {
  private waitingReaders: Array<() => void> = [];
  private waitingWriters: Array<() => void> = [];
  private activeReaders = 0;
  private activeWriter = false;
  private writerPreference: boolean

  constructor(writerPreference = false) {
    this.writerPreference = writerPreference
  }

  /**
   * Acquire read lock
   * @returns Function to release the read lock
   */
  async acquireReadLock() {
    // If there is an active writer, or waiting writers and writer preference is enabled
    if (this.activeWriter || (this.writerPreference && this.waitingWriters.length > 0)) {
      await new Promise<void>(resolve => {
        this.waitingReaders.push(resolve)
      })
    }

    this.activeReaders++

    return () => this.releaseReadLock()
  }

  /**
   * Acquire write lock
   * @returns Function to release the write lock
   */
  async acquireWriteLock() {
    // If there are active readers or an active writer
    if (this.activeReaders > 0 || this.activeWriter) {
      await new Promise<void>(resolve => {
        this.waitingWriters.push(resolve)
      })
    }

    this.activeWriter = true

    return () => this.releaseWriteLock()
  }

  /**
   * Release read lock
   */
  private releaseReadLock() {
    this.activeReaders--
    this.wakeUpWaiters()
  }

  /**
   * Release write lock
   */
  private releaseWriteLock() {
    this.activeWriter = false
    this.wakeUpWaiters()
  }

  /**
   * Wake up waiting operations
   */
  private wakeUpWaiters() {
    if (this.activeWriter || this.activeReaders > 0) {
      return // If there are still active readers or writers, don't wake up any waiters
    }

    if (this.writerPreference && this.waitingWriters.length > 0) {
      // Prioritize waking up a waiting writer
      const writer = this.waitingWriters.shift()
      writer?.()
    } else if (this.waitingReaders.length > 0) {
      // Wake up all waiting readers
      const readers = [...this.waitingReaders]
      this.waitingReaders = []
      readers.forEach(reader => reader())
    } else if (this.waitingWriters.length > 0) {
      // Wake up a waiting writer
      const writer = this.waitingWriters.shift()
      writer?.()
    }
  }

  /**
   * Execute a function with read lock
   * @param fn Function to execute
   * @returns Result of the function
   */
  async withReadLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireReadLock()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Execute a function with write lock
   * @param fn Function to execute
   * @returns Result of the function
   */
  async withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireWriteLock()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Get current lock state information
   * @returns Lock status information
   */
  getStatus() {
    return {
      activeReaders: this.activeReaders,
      activeWriter: this.activeWriter,
      waitingReaders: this.waitingReaders.length,
      waitingWriters: this.waitingWriters.length,
      writerPreference: this.writerPreference
    }
  }

}
