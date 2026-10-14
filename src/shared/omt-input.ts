/** Native receive payloads. Audio samples are planar, one complete channel after another. */
export interface OmtInputSource { name: string; address: string }
export type OmtInputFrame = {
  type: 'video'; data: Uint8Array; texture?: { id: number; handle: string; owner: number }; width: number; height: number; stride: number; flags: number
  timestamp: number; frameRateN: number; frameRateD: number
} | {
  type: 'audio'; data: Float32Array; sampleRate: number; channels: number; samplesPerChannel: number; timestamp: number
}
export interface OmtInputPacket { address: string; sequence: number; frame: OmtInputFrame }

/** Both discovery names (HOST (SOURCE)) and explicit OMT URLs are accepted by libomt. */
export function validOmtAddress(address: unknown): address is string {
  if (typeof address !== 'string' || !address.trim() || address.length > 1023 || /[\x00-\x1f]/.test(address)) return false
  if (!address.startsWith('omt://')) return /^[^()]+ \(.+\)$/.test(address)
  try {
    const url = new URL(address)
    return url.protocol === 'omt:' && !!url.hostname && !!url.port && Number(url.port) > 0 && Number(url.port) <= 65535
      && !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/')
  } catch { return false }
}
