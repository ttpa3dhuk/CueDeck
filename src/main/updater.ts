import { app, net } from 'electron'

const RELEASES_API =
  'https://api.github.com/repos/ttpa3dhuk/CueDeck/releases/latest'

export interface UpdateInfo {
  newerVersion: string
  url: string
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!data.tag_name || !data.html_url) return null
    const remote = data.tag_name.replace(/^v/i, '').trim()
    const local = app.getVersion()
    if (compareVersions(remote, local) > 0) {
      return { newerVersion: remote, url: data.html_url }
    }
    return null
  } catch {
    return null
  }
}
