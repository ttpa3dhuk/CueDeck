/**
 * Привязки к библиотеке NDI (Vizrt NDI SDK) через koffi (FFI).
 *
 * Берём только отправку: NDI сам кодирует кадр (H.264/скоростной кодек внутри),
 * поэтому отдаём сырой BGRA — своего кодека, в отличие от OMT, нет.
 * Структуры и сигнатуры — из Processing.NDI.FrameTypes.h и Processing.NDI.Send.h.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type Koffi = typeof import('koffi')
type Fn = ReturnType<import('koffi').IKoffiLib['func']>

/** FourCC из NDI_LIB_FOURCC: байты 'B','G','R','A' как little-endian 32 бита. */
export const NDI_FOURCC_BGRA = 0x41524742
export const NDI_FOURCC_BGRX = 0x58424742
export const NDI_FOURCC_UYVY = 0x59565955
/** NDIlib_frame_format_type_progressive. */
export const NDI_FRAME_FORMAT_PROGRESSIVE = 1
/** NDIlib_send_timecode_synthesize (INT64_MAX) — NDI сам ведёт метки и часы. */
export const NDI_TIMECODE_SYNTHESIZE = 9223372036854775807n

export interface NdiLib {
  koffi: Koffi
  initialize: Fn
  destroy: Fn
  version: Fn
  sendCreate: Fn
  sendDestroy: Fn
  sendVideo: Fn
  sendVideoAsync: Fn
  sendAudio: Fn
  sendConnections: Fn
  sendGetTally: Fn
}

/** Кадр видео NDI v2 — раскладка ровно как в SDK (koffi сам ставит выравнивание). */
export interface NdiVideoFrame {
  xres: number
  yres: number
  FourCC: number
  frame_rate_N: number
  frame_rate_D: number
  picture_aspect_ratio: number
  frame_format_type: number
  timecode: bigint
  p_data: Buffer
  line_stride_in_bytes: number
  p_metadata: string | null
  timestamp: bigint
}

/** Кадр звука NDI v2 — planar float (FLTP): каналы подряд. */
export interface NdiAudioFrame {
  sample_rate: number
  no_channels: number
  no_samples: number
  timecode: bigint
  p_data: Buffer
  channel_stride_in_bytes: number
  p_metadata: string | null
  timestamp: bigint
}

/** Имя файла runtime NDI на платформе. */
export function ndiFileName(): string {
  return process.platform === 'win32' ? 'Processing.NDI.Lib.x64.dll' : 'libndi.dylib'
}

let registeredTypes = false

/** Throws on load failure; callers own reporting and process-specific paths. */
export function createNdiLibrary(directory: string): NdiLib {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('NDI is supported on macOS and Windows')
  const path = join(directory, ndiFileName())
  if (!existsSync(path)) throw new Error(`Missing NDI library: ${path}`)
  const koffi = createRequire(import.meta.url)('koffi') as Koffi
  const l = koffi.load(path)

  if (!registeredTypes) {
    koffi.struct('NDI_video_frame_v2', {
      xres: 'int32', yres: 'int32', FourCC: 'int32', frame_rate_N: 'int32', frame_rate_D: 'int32',
      picture_aspect_ratio: 'float', frame_format_type: 'int32', timecode: 'int64',
      p_data: 'uint8_t *', line_stride_in_bytes: 'int32', p_metadata: 'str', timestamp: 'int64',
    })
    koffi.struct('NDI_audio_frame_v2', {
      sample_rate: 'int32', no_channels: 'int32', no_samples: 'int32', timecode: 'int64',
      p_data: 'float *', channel_stride_in_bytes: 'int32', p_metadata: 'str', timestamp: 'int64',
    })
    koffi.struct('NDI_tally', { on_program: 'bool', on_preview: 'bool' })
    koffi.struct('NDI_send_create', { p_ndi_name: 'str', p_groups: 'str', clock_video: 'bool', clock_audio: 'bool' })
    registeredTypes = true
  }

  return {
    koffi,
    initialize: l.func('bool NDIlib_initialize(void)'),
    destroy: l.func('void NDIlib_destroy(void)'),
    version: l.func('const char *NDIlib_version(void)'),
    sendCreate: l.func('void *NDIlib_send_create(NDI_send_create *settings)'),
    sendDestroy: l.func('void NDIlib_send_destroy(void *inst)'),
    sendVideo: l.func('void NDIlib_send_send_video_v2(void *inst, NDI_video_frame_v2 *frame)'),
    sendVideoAsync: l.func('void NDIlib_send_send_video_async_v2(void *inst, NDI_video_frame_v2 *frame)'),
    sendAudio: l.func('void NDIlib_send_send_audio_v2(void *inst, NDI_audio_frame_v2 *frame)'),
    sendConnections: l.func('int NDIlib_send_get_no_connections(void *inst, uint32_t timeoutMs)'),
    sendGetTally: l.func('bool NDIlib_send_get_tally(void *inst, _Out_ NDI_tally *tally, uint32_t timeoutMs)'),
  }
}
