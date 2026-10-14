import type { OmtInputFrame } from '../../shared/omt-input'
type Video = Extract<OmtInputFrame, { type: 'video' }>
type Listener = (frame: VideoFrame, address: string, metadata: Video) => void
const listeners = new Set<Listener>()
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'cuedeck-omt-gpu' || !(event.data.frame instanceof VideoFrame)) return
  const { frame, metadata } = event.data as { frame: VideoFrame; metadata: { address: string; frame: Video } }
  try { for (const listener of listeners) listener(frame.clone(), metadata.address, metadata.frame) }
  finally { frame.close() }
})
export function onGpuFrame(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener) }
