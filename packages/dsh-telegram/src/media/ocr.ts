/**
 * Reading the text in an image without a model.
 *
 * A fallback, and only that. When no vision model is configured the image is
 * otherwise refused before it is even downloaded, and the user gets a sentence
 * about model configuration instead of an answer. Poor OCR beats nothing, and
 * the thing people most often send a coding agent from a phone — a screenshot
 * of an error, a log, a stack trace — is exactly what OCR is good at: crisp
 * text, high contrast, no perspective.
 *
 * What it is NOT is a vision model. It reads text; it does not see. A
 * whiteboard, an architecture diagram, a chart, a UI layout all come back as
 * scattered words with no structure and nothing to say what the picture was.
 * So its output is labelled as OCR wherever it goes — an agent handed
 * unlabelled OCR treats a misread digit as a fact.
 *
 * Tesseract is never assumed. It ships with no operating system this runs on,
 * so its absence is the normal case and is detected rather than discovered
 * halfway through a message.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

/** How long one page may take before the message moves on without it. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Below this many characters, whatever came back is noise rather than text. */
const MIN_USEFUL_CHARS = 8

/** Running a command; injected so tests need no Tesseract. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>

/** Construction options. */
export interface OcrReaderOptions {
  /** Languages to read, as Tesseract names them. Several join with `+`. */
  readonly languages?: string
  readonly binary?: string
  readonly run?: CommandRunner
  readonly timeoutMs?: number
  readonly logger?: Logger
}

export class OcrReader {
  private readonly logger: Logger
  /** Cached, because probing spawns a process and the answer cannot change. */
  private probed: Promise<boolean> | undefined

  constructor(private readonly options: OcrReaderOptions = {}) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Whether Tesseract is actually installed here.
   *
   * Probed once and remembered. A deployment without it is the ordinary case,
   * not a fault: nothing this runs on ships Tesseract.
   */
  async available(): Promise<boolean> {
    this.probed ??= this.probe()
    return await this.probed
  }

  /**
   * Read the text in an image.
   *
   * @param data - the image bytes.
   * @returns the text, or undefined when there was none worth having.
   */
  async read(data: Uint8Array): Promise<string | undefined> {
    if (!(await this.available())) return undefined

    const directory = await mkdtemp(join(tmpdir(), 'dsh-telegram-ocr-'))
    const input = join(directory, 'image')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      await writeFile(input, data)

      // `stdout` rather than a file: one fewer artifact to clean up, and the
      // text is small enough that a pipe is the simpler path.
      const text = await this.exec(
        [input, 'stdout', '-l', this.options.languages ?? 'eng'],
        controller.signal,
      )

      const tidy = tidyUp(text)
      return tidy.length >= MIN_USEFUL_CHARS ? tidy : undefined
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not read the image with OCR', error)
      return undefined
    } finally {
      clearTimeout(timer)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Ask Tesseract whether it is there. */
  private async probe(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)

    try {
      await this.exec(['--version'], controller.signal)
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Run the binary and return what it printed. */
  private exec(args: readonly string[], signal: AbortSignal): Promise<string> {
    const binary = this.options.binary ?? 'tesseract'
    if (this.options.run) return this.options.run(binary, args, signal)

    return new Promise((resolve, reject) => {
      execFile(binary, [...args], { signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
  }
}

/**
 * How the text is introduced to the agent.
 *
 * The caveat is not politeness. An agent handed unlabelled OCR treats a
 * misread digit as a fact, and a receipt's amount is exactly the sort of thing
 * it gets wrong.
 */
export function labelOcr(text: string): string {
  return (
    'Text read from the image by OCR. No vision model is configured, so ' +
    'nothing has described the picture itself and the reading may contain ' +
    'mistakes — treat exact figures with care:\n\n' +
    text
  )
}

/** Collapse the ragged whitespace OCR leaves between columns and lines. */
function tidyUp(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}
