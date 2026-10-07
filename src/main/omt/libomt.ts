/**
 * Привязка к libomt — библиотеке Open Media Transport (MIT, github.com/openmediatransport).
 * Через koffi (FFI): никакой компиляции под каждую версию Electron, бинарник
 * libomt берётся готовый из официального релиза (scripts/fetch-omt.cjs).
 *
 * Грузится лениво — при первом включённом выходе. Не загрузилась (старая
 * macOS, нет файла) — выходы OMT недоступны, остальная программа работает.
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { logsDir } from '../diag.js'
import { t } from '../../shared/i18n.js'

type Koffi = typeof import('koffi')
type Fn = ReturnType<import('koffi').IKoffiLib['func']>

export const OMT_CODEC_VMX1 = 0x31584d56
export const OMT_FRAME_VIDEO = 2
export const OMT_FLAG_ALPHA = 2
export const OMT_FLAG_PREMULTIPLIED = 4
export const OMT_QUALITY_HIGH = 100
export const VMX_PROFILE_OMT_HQ = 199
export const VMX_COLORSPACE_BT709 = 709

export interface OmtLib {
  koffi: Koffi
  sendCreate: Fn
  sendDestroy: Fn
  send: Fn
  sendConnections: Fn
  sendGetTally: Fn
  sendGetAddress: Fn
  sendSetInfo: Fn
  vmxCreate: Fn
  vmxDestroy: Fn
  vmxEncodeBGRA: Fn
  vmxEncodeBGRX: Fn
  vmxSaveTo: Fn
}

let lib: OmtLib | null = null
let loadError: string | null = null

/** Папка с libomt: в сборке — ресурсы приложения, в разработке — vendor/ репозитория. */
function libDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'omt')
  return join(app.getAppPath(), 'vendor', 'omt', process.platform === 'win32' ? 'win' : 'mac')
}

function fileName(base: string): string {
  return process.platform === 'win32' ? `${base}.dll` : `${base}.dylib`
}

/** Загрузить libomt; null — недоступно, причина в omtLoadError(). */
export function loadOmt(): OmtLib | null {
  if (lib || loadError) return lib
  try {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error(t('OMT в CueDeck есть только на macOS и Windows'))
    }
    const dir = libDir()
    const omtPath = join(dir, fileName('libomt'))
    if (!existsSync(omtPath)) throw new Error(t('нет файла {path}', { path: omtPath }))
    const koffi = createRequire(import.meta.url)('koffi') as Koffi
    // Кодек VMX — отдельная библиотека рядом. На Windows загрузчик ищет её не в
    // папке libomt, а в папке программы, поэтому грузим первой по полному пути.
    // Кодируем им сами (см. outputs.ts), поэтому без неё выходов нет.
    const vmxPath = join(dir, fileName('libvmx'))
    if (!existsSync(vmxPath)) throw new Error(t('нет файла {path}', { path: vmxPath }))
    const vmx = koffi.load(vmxPath)
    const l = koffi.load(omtPath)

    koffi.struct('OMTMediaFrame', {
      Type: 'int32', Timestamp: 'int64', Codec: 'int32', Width: 'int32', Height: 'int32', Stride: 'int32', Flags: 'int32',
      FrameRateN: 'int32', FrameRateD: 'int32', AspectRatio: 'float', ColorSpace: 'int32',
      SampleRate: 'int32', Channels: 'int32', SamplesPerChannel: 'int32',
      Data: 'void *', DataLength: 'int32', CompressedData: 'void *', CompressedLength: 'int32',
      FrameMetadata: 'void *', FrameMetadataLength: 'int32',
    })
    koffi.struct('OMTTally', { preview: 'int32', program: 'int32' })
    koffi.struct('VMX_SIZE', { width: 'int32', height: 'int32' })
    const str = koffi.array('char', 1024, 'String')
    koffi.struct('OMTSenderInfo', {
      ProductName: str, Manufacturer: str, Version: str, Reserved1: str, Reserved2: str, Reserved3: str,
    })

    // Журнал libomt — в папку журналов CueDeck: попадёт в отчёт о проблеме.
    l.func('void omt_setloggingfilename(const char *filename)')(join(logsDir(), 'omt.log'))

    lib = {
      koffi,
      sendCreate: l.func('void *omt_send_create(const char *name, int quality)'),
      sendDestroy: l.func('void omt_send_destroy(void *inst)'),
      send: l.func('int omt_send(void *inst, OMTMediaFrame *frame)'),
      sendConnections: l.func('int omt_send_connections(void *inst)'),
      sendGetTally: l.func('int omt_send_gettally(void *inst, int timeoutMs, _Out_ OMTTally *tally)'),
      sendGetAddress: l.func('int omt_send_getaddress(void *inst, _Out_ uint8_t *address, int maxLength)'),
      sendSetInfo: l.func('void omt_send_setsenderinformation(void *inst, OMTSenderInfo *info)'),
      vmxCreate: vmx.func('void *VMX_Create(VMX_SIZE dimensions, int profile, int colorSpace)'),
      vmxDestroy: vmx.func('void VMX_Destroy(void *inst)'),
      vmxEncodeBGRA: vmx.func('int VMX_EncodeBGRA(void *inst, uint8_t *src, int stride, int interlaced)'),
      vmxEncodeBGRX: vmx.func('int VMX_EncodeBGRX(void *inst, uint8_t *src, int stride, int interlaced)'),
      vmxSaveTo: vmx.func('int VMX_SaveTo(void *inst, uint8_t *dst, int maxLen)'),
    }
    log.info(`omt: libomt загружена (${omtPath})`)
  } catch (err) {
    loadError = (err as Error).message || String(err)
    log.warn(`omt: libomt не загрузилась — ${loadError}`)
  }
  return lib
}

export function omtLoadError(): string | null {
  return loadError
}
