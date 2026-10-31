import type { AppState } from '../shared/types.js'

type ProgramSource = Pick<AppState, 'pdfPath' | 'pdfSha1' | 'fileKind' | 'slideMedia'>
type Lease = { expires: number; file: string | null; slides: Map<string, string> }

/** Retired players may finish a short transition after either deck changes. */
export class ProgramMediaLeases {
  private entries = new Map<string, Lease>()
  constructor(private slidePath: (sha1: string, file: string) => string,
    private now: () => number = Date.now) {}

  retain(source: ProgramSource): void {
    this.prune()
    const sha1 = source.pdfSha1
    if (!sha1 || !source.pdfPath || !['video', 'pptx'].includes(source.fileKind ?? '')) return
    const slides = new Map<string, string>()
    if (source.fileKind === 'pptx') for (const media of source.slideMedia) {
      if (this.safeName(media.file)) slides.set(media.file, this.slidePath(sha1, media.file))
    }
    this.entries.delete(sha1)
    this.entries.set(sha1, { expires: this.now() + 15_000,
      file: source.fileKind === 'video' ? source.pdfPath : null, slides })
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!)
  }

  resolve(sha1: string, slideFile?: string): string | null {
    this.prune()
    const lease = this.entries.get(sha1)
    if (!lease) return null
    return slideFile === undefined ? lease.file
      : this.safeName(slideFile) ? lease.slides.get(slideFile) ?? null : null
  }

  private safeName(file: string): boolean {
    return Boolean(file) && !/[\\/]/.test(file) && !file.includes('..')
  }

  private prune(): void {
    for (const [key, lease] of this.entries) if (lease.expires <= this.now()) this.entries.delete(key)
  }
}
