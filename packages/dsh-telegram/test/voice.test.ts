import { describe, expect, it, vi } from 'vitest'

import { isSafeSpeechEndpoint, TelegramVoiceTranscriber } from '../src/media/voice.js'

const voice = { file_id: 'voice-1', file_size: 12, duration: 4 }

function build(options: { status?: number; text?: string; fileSize?: number; duration?: number; endpoint?: string } = {}) {
  const source = {
    getFile: vi.fn(async () => ({ file_path: 'voice/file.oga', file_size: options.fileSize ?? 12 })),
    downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-token', 'content-type': 'audio/ogg' })
    return new Response(JSON.stringify({ text: options.text ?? 'Please check the build' }), {
      status: options.status ?? 200,
    })
  }) as unknown as typeof fetch
  const reader = new TelegramVoiceTranscriber({
    source,
    endpoint: options.endpoint ?? 'http://127.0.0.1:8798/v1/transcriptions',
    token: 'secret-token',
    fetchImpl,
    maxBytes: 8 * 1024 * 1024,
    maxSeconds: 45,
    timeoutMs: 1000,
  })
  return { reader, source, fetchImpl }
}

describe('TelegramVoiceTranscriber', () => {
  it('requires TLS except for a loopback speech service', () => {
    expect(isSafeSpeechEndpoint('http://asr.example.test/v1/transcriptions')).toBe(false)
    expect(isSafeSpeechEndpoint('http://127.0.0.1:8798/v1/transcriptions')).toBe(true)
    expect(isSafeSpeechEndpoint('https://asr.example.test/v1/transcriptions')).toBe(true)
  })

  it('refuses an unsafe endpoint before downloading a voice note', async () => {
    const { reader, source, fetchImpl } = build({ endpoint: 'http://asr.example.test/v1/transcriptions' })
    expect((await reader.transcribe(voice)).kind).toBe('failure')
    expect(source.getFile).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloads a voice note and sends raw OGG to the ASR service', async () => {
    const { reader, source, fetchImpl } = build()
    expect(await reader.transcribe(voice)).toEqual({ kind: 'success', text: 'Please check the build' })
    expect(source.getFile).toHaveBeenCalledWith('voice-1')
    expect(source.downloadFile).toHaveBeenCalledWith('voice/file.oga', undefined)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('refuses oversized and long voice before fetching bytes', async () => {
    const { reader, source, fetchImpl } = build()
    expect((await reader.transcribe({ ...voice, file_size: 8 * 1024 * 1024 + 1 })).kind).toBe('failure')
    expect((await reader.transcribe({ ...voice, duration: 46 })).kind).toBe('failure')
    expect(source.getFile).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not return an empty transcript as a prompt', async () => {
    const { reader } = build({ text: '  ' })
    expect((await reader.transcribe(voice)).kind).toBe('failure')
  })

  it('turns ASR busy and transport errors into safe failures', async () => {
    const busy = build({ status: 429 })
    expect(await busy.reader.transcribe(voice)).toEqual({ kind: 'failure', notice: 'Speech recognition is busy. Please try again.' })
    const failed = build()
    vi.mocked(failed.fetchImpl).mockRejectedValueOnce(new Error('https://service/secret-token'))
    const result = await failed.reader.transcribe(voice)
    expect(result.kind).toBe('failure')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('rejects oversized speech responses and transcripts', async () => {
    const tooLarge = build()
    vi.mocked(tooLarge.fetchImpl).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'x'.repeat(65_536) })),
    )
    expect((await tooLarge.reader.transcribe(voice)).kind).toBe('failure')

    const tooLong = build()
    vi.mocked(tooLong.fetchImpl).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'x'.repeat(3501) })),
    )
    expect((await tooLong.reader.transcribe(voice)).kind).toBe('failure')
  })
})
