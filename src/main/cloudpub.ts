import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { delimiter, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { updateCloudpubHostname } from './cloudpub-api.js'
import { machineIdentity } from './machine-identity.js'
import { cloudpubAppPaths } from './cloudpub-paths.js'

export function clickerComputerName(identity: string): string {
  return 'cuedeck-' + createHash('sha256').update('cuedeck-clicker-v1\0' + identity).digest('hex').slice(0, 10)
}

export interface CloudpubRecord { id: string; target: string; publicUrl: string; executable: string; automatic?: boolean; computerName?: string }
export interface CloudpubStore { load(): Promise<CloudpubRecord | null>; save(value: CloudpubRecord): Promise<void> }
export interface CloudpubEndpoint { id: string; target: string; publicUrl: string; online: boolean; status: string; name?: string }
type Runner = (file: string, args: string[], timeout?: number, signal?: AbortSignal) => Promise<string>
const guid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

/** CLI output is data. Only an exact loopback target and HTTPS origin can be adopted. */
export function cloudpubEndpoints(output: string): CloudpubEndpoint[] {
  return output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(online|offline|starting|stopping|error|unknown)\s+([a-f\d-]{36})\s+(?:\[[^\]\r\n]{0,200}\]\s+)?(http:\/\/\S+)\s+->\s+(https:\/\/\S+)$/i)
    if (!match || !guid.test(match[2])) return []
    try {
      const local = new URL(match[3]); const remote = new URL(match[4])
      if (!['127.0.0.1', 'localhost'].includes(local.hostname) || !local.port || local.pathname !== '/' || local.search || local.hash || local.username || local.password || remote.username || remote.password || remote.pathname !== '/' || remote.search || remote.hash || remote.port) return []
      const name = line.match(/^[^\[]+\[([^\]]+)\]\s+http:/)?.[1]
      return [{ id: match[2], target: 'http://127.0.0.1:' + local.port, publicUrl: remote.origin, online: match[1].toLowerCase() === 'online', status: match[1].toLowerCase(), ...(name ? { name } : {}) }]
    } catch { return [] }
  })
}

export function runCloudpub(file: string, args: string[], timeout = 20000, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(Error('cloudpub-cancelled'))
  return new Promise((resolve, reject) => {
    // Never place credentials in arguments, invoke a shell, or launch all user publications.
    const child = spawn(file, ['-l', 'error', '-r', ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let bytes = 0; let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) } else resolve(output)
    }
    // Some GUI builds keep secondary start/stop clients alive after acknowledgement.
    // Their result is verified using `ls`; never treat this timeout alone as success.
    const secondary = args[0] === 'start' || args[0] === 'stop'
    const timer = setTimeout(() => { if (secondary) { child.kill(); finish() } else finish(Error('cloudpub-timeout')) }, secondary ? Math.min(timeout, 3000) : timeout)
    const abort = () => finish(Error('cloudpub-cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 65536) finish(Error('cloudpub-output-limit')); else output += data.toString('utf8') })
    child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 65536) finish(Error('cloudpub-output-limit')) })
    child.once('error', () => finish(Error('cloudpub-executable')))
    child.once('close', code => finish(code === 0 ? undefined : Error('cloudpub-command')))
  })
}

export async function findCloudpub(preferred?: string): Promise<string> {
  const names = process.platform === 'win32' ? ['cloudpub.exe', 'clo.exe'] : ['clo', 'cloudpub']
  const candidates = [...cloudpubAppPaths(process.platform, homedir(), preferred), ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
    .filter((p): p is string => Boolean(p)).flatMap(p => names.map(name => join(p, 'cloudpub', name))),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(p => names.map(name => join(p, name)))]
  for (const file of candidates) if (file && isAbsolute(file)) { try { await access(file); if ((await stat(file)).isFile()) return file } catch { /* Try the next installed location. */ } }
  throw Error('cloudpub-not-found')
}

/** Controls only the publication whose GUID AND target were saved by CueDeck. */
export class CloudpubTunnel {
  private record: CloudpubRecord | null = null
  private loaded = false
  private busy = false
  private publicationName = ''
  private controller: AbortController | null = null
  cancel(): void { this.controller?.abort() }
  constructor(private store: CloudpubStore, private run: Runner = runCloudpub, private locate = findCloudpub,
    private computerName: () => string | Promise<string> = async () => clickerComputerName(await machineIdentity()), private rename = updateCloudpubHostname) {}
  private async load(): Promise<void> {
    if (this.loaded) return
    const value = await this.store.load()
    if (value && (!guid.test(value.id) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.target) || typeof value.executable !== 'string')) throw Error('cloudpub-record')
    if (value?.computerName && !/^cuedeck-[a-f0-9]{10}$/.test(value.computerName)) throw Error('cloudpub-record')
    this.record = value; this.loaded = true
  }
  async configured(): Promise<boolean> { await this.load(); return Boolean(this.record && this.record.automatic !== false) }
  async useManualMode(): Promise<void> {
    await this.load()
    if (this.record) { const next = { ...this.record, automatic: false }; await this.store.save(next); this.record = next }
  }
  async connect(target: string, activate: (url: string) => Promise<void>, executable?: string): Promise<string> {
    if (this.busy) throw Error('cloudpub-busy')
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(target)) throw Error('cloudpub-target')
    this.busy = true
    const controller = new AbortController(); this.controller = controller
    let owned: CloudpubRecord | null = null
    let registration: { file: string; previous: Set<string> } | null = null
    try {
      await this.load()
      if (!this.publicationName) this.publicationName = await this.computerName()
      const file = await this.locate(executable ?? this.record?.executable)
      const run: Runner = (file, args, timeout) => this.run(file, args, timeout, controller.signal)
      const list = () => run(file, ['ls']).then(cloudpubEndpoints)
      let endpoints = await list()
      let endpoint = this.record && endpoints.find(e => e.id === this.record!.id && e.target === this.record!.target)
      if (this.record && endpoints.some(e => e.id === this.record!.id) && !endpoint) throw Error('cloudpub-ownership')
      if (!endpoint) endpoint = endpoints.find(e => e.publicUrl === 'https://' + this.publicationName + '.cloudpub.ru' && e.name === this.publicationName)
      if (!endpoint) {
        // Do not adopt an existing publication just because it happens to use our port.
        const previous = new Set(endpoints.map(e => e.id))
        registration = { file, previous }
        await run(file, ['register', 'http', target, '--name', this.publicationName], 30000)
        endpoints = await list()
        const created = endpoints.filter(e => !previous.has(e.id) && e.target === target)
        if (created.length !== 1) throw Error('cloudpub-registration')
        endpoint = created[0]
      }
      owned = { id: endpoint.id, target: endpoint.target, publicUrl: endpoint.publicUrl, executable: file, automatic: true, computerName: this.publicationName }
      // Persist ownership before activation so a failed handshake can still be stopped safely.
      this.record = owned; await this.store.save(owned)
      const desired = 'https://' + this.publicationName + '.cloudpub.ru'
      if (endpoint.publicUrl !== desired || endpoint.target !== target) {
        await this.stopRecord(owned)
        owned.publicUrl = await this.rename(owned, this.publicationName, undefined, target)
        owned.target = target
        await this.store.save(owned)
      }
      if (!endpoint.online || endpoint.publicUrl !== desired || endpoint.target !== target) await run(file, ['start', endpoint.id])
      const active = (await list()).find(e => e.id === endpoint!.id && e.target === target && e.online)
      if (!active) throw Error('cloudpub-agent-offline')
      if (active.publicUrl !== desired) throw Error('cloudpub-hostname-response')
      await activate(active.publicUrl)
      return active.publicUrl
    } catch (error) {
      // Registration may have reached the server even if its acknowledgement timed out.
      if (!owned && registration) {
        const pending = registration
        const created = cloudpubEndpoints(await this.run(pending.file, ['ls'], 5000).catch(() => '')).filter(e => !pending.previous.has(e.id) && e.target === target)
        if (created.length === 1) {
          owned = { ...created[0], executable: pending.file, computerName: this.publicationName }
          this.record = owned; await this.store.save(owned).catch(() => undefined)
        }
      }
      if (owned) { try { await this.stopRecord(owned) } catch { throw Error('cloudpub-cleanup') } }
      throw error
    } finally { this.busy = false; this.controller = null }
  }
  async stop(): Promise<void> {
    await this.load()
    if (!this.record) return
    await this.stopRecord(this.record)
  }
  private async stopRecord(record: CloudpubRecord): Promise<void> {
    const endpoints = cloudpubEndpoints(await this.run(record.executable, ['ls'], 5000))
    const endpoint = endpoints.find(e => e.id === record.id)
    if (!endpoint) return
    if (endpoint.target !== record.target) throw Error('cloudpub-ownership')
    if (endpoint.status === 'offline') return
    await this.run(record.executable, ['stop', record.id], 5000)
    const remaining = cloudpubEndpoints(await this.run(record.executable, ['ls'], 5000)).find(e => e.id === record.id)
    if (remaining && remaining.status !== 'offline') throw Error('cloudpub-stop')
  }
}
