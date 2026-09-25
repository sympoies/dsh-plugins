/** Telegram voice notes become text before entering a DSH conversation. */

import type { MediaSource } from './collect.js'

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_TRANSCRIPT_CHARS = 3500

/** Credentials and recordings may use cleartext only on the local host. */
export function isSafeSpeechEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

export interface VoiceNote {
  readonly file_id: string
  readonly file_size?: number
  readonly duration?: number
}

export type VoiceResult =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'failure'; readonly notice: string }

export interface VoiceTranscriber {
  transcribe(voice: VoiceNote): Promise<VoiceResult>
}

export interface VoiceTranscriberOptions {
  readonly source: MediaSource
  readonly endpoint: string
  readonly token: string
  readonly maxBytes: number
  readonly maxSeconds: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

export class TelegramVoiceTranscriber implements VoiceTranscriber {
  constructor(private readonly options: VoiceTranscriberOptions) {}

  async transcribe(voice: VoiceNote): Promise<VoiceResult> {
    if (!isSafeSpeechEndpoint(this.options.endpoint)) {
      return { kind: 'failure', notice: 'Speech recognition is not configured.' }
    }
    if (voice.duration !== undefined && voice.duration > this.options.maxSeconds) {
      return { kind: 'failure', notice: 'That voice note is too long to transcribe.' }
    }
    if (voice.file_size !== undefined && voice.file_size > this.options.maxBytes) {
      return { kind: 'failure', notice: 'That voice note is too large to transcribe.' }
    }

    try {
      const file = await this.options.source.getFile(voice.file_id)
      if (!file.file_path) return { kind: 'failure', notice: 'Telegram did not provide the voice file.' }
      if (file.file_size !== undefined && file.file_size > this.options.maxBytes) {
        return { kind: 'failure', notice: 'That voice note is too large to transcribe.' }
      }
      const bytes = await this.options.source.downloadFile(file.file_path, this.options.signal)
      if (bytes.length === 0 || bytes.length > this.options.maxBytes) {
        return { kind: 'failure', notice: 'That voice note is empty or too large to transcribe.' }
      }

      const deadline = AbortSignal.timeout(this.options.timeoutMs)
      const signal = this.options.signal
        ? AbortSignal.any([this.options.signal, deadline])
        : deadline
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'audio/ogg',
        },
        body: Buffer.from(bytes),
        signal,
        redirect: 'error',
      })
      if (response.status === 429) {
        return { kind: 'failure', notice: 'Speech recognition is busy. Please try again.' }
      }
      if (response.status === 413 || response.status === 422) {
        return { kind: 'failure', notice: 'That voice note could not be transcribed.' }
      }
      if (!response.ok) {
        return { kind: 'failure', notice: 'Speech recognition is unavailable. Please try again.' }
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (declaredLength > MAX_RESPONSE_BYTES) {
        return { kind: 'failure', notice: 'Speech recognition returned too much text.' }
      }
      const reader = response.body?.getReader()
      if (!reader) return { kind: 'failure', notice: 'Speech recognition returned no text.' }
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          return { kind: 'failure', notice: 'Speech recognition returned too much text.' }
        }
        chunks.push(value)
      }
      const payload: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
      const text =
        typeof payload === 'object' && payload !== null && 'text' in payload &&
        typeof payload.text === 'string'
          ? payload.text.trim()
          : ''
      if (text.length > MAX_TRANSCRIPT_CHARS) {
        return { kind: 'failure', notice: 'Speech recognition returned too much text.' }
      }
      return text
        ? { kind: 'success', text }
        : { kind: 'failure', notice: 'No speech was recognized. Please try again.' }
    } catch {
      // Fetch errors may include the URL or headers. Neither belongs in chat or logs.
      return { kind: 'failure', notice: 'Speech recognition is unavailable. Please try again.' }
    }
  }
}
