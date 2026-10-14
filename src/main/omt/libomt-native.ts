/** Native OMT bindings shared by main outputs and the isolated receive utility. */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type Koffi = typeof import('koffi')
type Fn = ReturnType<import('koffi').IKoffiLib['func']>

export const OMT_CODEC_VMX1 = 0x31584d56
export const OMT_CODEC_FPA1 = 0x31415046
export const OMT_CODEC_BGRA = 0x41524742
export const OMT_FRAME_AUDIO = 4
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
  discoveryGetAddresses: Fn
  receiveCreate: Fn
  receiveDestroy: Fn
  receive: Fn
  receiveSetTally: Fn
  vmxCreate: Fn
  vmxDestroy: Fn
  vmxEncodeBGRA: Fn
  vmxEncodeBGRX: Fn
  vmxSaveTo: Fn
}

let registeredTypes = false

function fileName(base: string): string {
  return process.platform === 'win32' ? `${base}.dll` : `${base}.dylib`
}

/** Throws on load failure; callers own reporting and process-specific paths. */
export function createOmtLibrary(directory: string, logFile: string): OmtLib {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('OMT is supported on macOS and Windows')
  const omtPath = join(directory, fileName('libomt'))
  if (!existsSync(omtPath)) throw new Error(`Missing OMT library: ${omtPath}`)
  const koffi = createRequire(import.meta.url)('koffi') as Koffi
  // Кодек VMX — отдельная библиотека рядом. На Windows загрузчик ищет её не в
  // папке libomt, а в папке программы, поэтому грузим первой по полному пути.
  // Кодируем им сами (см. outputs.ts), поэтому без неё выходов нет.
  const vmxPath = join(directory, fileName('libvmx'))
  if (!existsSync(vmxPath)) throw new Error(`Missing OMT codec: ${vmxPath}`)
  const vmx = koffi.load(vmxPath)
  const l = koffi.load(omtPath)

  if (!registeredTypes) {
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

    registeredTypes = true
  }

  // Журнал libomt — в папку журналов CueDeck: попадёт в отчёт о проблеме.
  l.func('void omt_setloggingfilename(const char *filename)')(logFile)

  return {
    koffi,
    sendCreate: l.func('void *omt_send_create(const char *name, int quality)'),
    sendDestroy: l.func('void omt_send_destroy(void *inst)'),
    send: l.func('int omt_send(void *inst, OMTMediaFrame *frame)'),
    sendConnections: l.func('int omt_send_connections(void *inst)'),
    sendGetTally: l.func('int omt_send_gettally(void *inst, int timeoutMs, _Out_ OMTTally *tally)'),
    sendGetAddress: l.func('int omt_send_getaddress(void *inst, _Out_ uint8_t *address, int maxLength)'),
    sendSetInfo: l.func('void omt_send_setsenderinformation(void *inst, OMTSenderInfo *info)'),
    discoveryGetAddresses: l.func('void *omt_discovery_getaddresses(_Out_ int *count)'),
    receiveCreate: l.func('void *omt_receive_create(const char *address, int types, int format, int flags)'),
    receiveDestroy: l.func('void omt_receive_destroy(void *inst)'),
    receive: l.func('OMTMediaFrame *omt_receive(void *inst, int types, int timeoutMs)'),
    receiveSetTally: l.func('void omt_receive_settally(void *inst, OMTTally *tally)'),
    vmxCreate: vmx.func('void *VMX_Create(VMX_SIZE dimensions, int profile, int colorSpace)'),
    vmxDestroy: vmx.func('void VMX_Destroy(void *inst)'),
    vmxEncodeBGRA: vmx.func('int VMX_EncodeBGRA(void *inst, uint8_t *src, int stride, int interlaced)'),
    vmxEncodeBGRX: vmx.func('int VMX_EncodeBGRX(void *inst, uint8_t *src, int stride, int interlaced)'),
    vmxSaveTo: vmx.func('int VMX_SaveTo(void *inst, uint8_t *dst, int maxLen)'),
  }
}
