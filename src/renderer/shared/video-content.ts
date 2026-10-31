/** Chromium can accept a container's audio while silently discarding its video codec. */
export function rejectAudioOnlyVideo(video: HTMLVideoElement, onUnsupported: () => void): void {
  video.addEventListener('loadeddata', () => {
    if (!video.getAttribute('src') || video.srcObject || video.readyState < 2 || video.videoWidth > 0 || video.videoHeight > 0) return
    video.pause()
    onUnsupported()
    // Reuse each surface's existing unsupported-video UI and poster fallback.
    video.dispatchEvent(new Event('error'))
  })
}
