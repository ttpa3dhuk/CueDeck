import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { CloudpubRecord } from './cloudpub.js'
import { cloudpubConfigPaths } from './cloudpub-paths.js'

// Public API schema: https://cloudpub.ru/api/schema/
// Read only the generated client's two scalar settings. Never log or persist the token.
async function credentials(): Promise<{ token: string }> {
  let text: string | undefined
  for (const file of cloudpubConfigPaths(process.platform, homedir(), process.env.APPDATA)) {
    try { text = await readFile(file, 'utf8'); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (text === undefined) throw Error('cloudpub-api-config')
  if (text.length > 65536) throw Error('cloudpub-api-config')
  const scalar = (key: string): string => {
    const value = text.match(new RegExp('^' + key + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')\\s*(?:#.*)?$', 'm'))?.[1]
    if (!value) throw Error('cloudpub-api-config')
    return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1)
  }
  const server = new URL(scalar('server'))
  if (!['https:', 'wss:'].includes(server.protocol) || server.hostname !== 'cloudpub.ru' || server.port || server.username || server.password) throw Error('cloudpub-api-server')
  const token = scalar('token')
  if (!/^[A-Za-z0-9._-]{16,1024}$/.test(token)) throw Error('cloudpub-api-config')
  return { token }
}

type ApiRequest = (path: string, method?: string, body?: unknown) => Promise<any>
export async function updateCloudpubHostname(record: CloudpubRecord, name: string, request?: ApiRequest, newTarget?: string): Promise<string> {
  if (!/^cuedeck-[a-f0-9]{10}$/.test(name)) throw Error('cloudpub-api-name')
  const host = name + '.cloudpub.ru'
  let api = request
  let agentId: string | undefined
  if (!api) {
    const credentialsValue = await credentials()
    const token = credentialsValue.token
    api = async (path, method = 'GET', body) => {
      if (!/^\/api\/endpoint\/publications\/(?:\?page=\d+&page_size=100|\d+\/)?$/.test(path)) throw Error('cloudpub-api-path')
      const response = await fetch('https://cloudpub.ru' + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!response.ok) { await response.body?.cancel(); throw Error('cloudpub-hostname-' + response.status) }
      const reader = response.body?.getReader(); if (!reader) throw Error('cloudpub-api-response')
      let text = ''; let size = 0
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1048576) throw Error('cloudpub-api-response'); text += Buffer.from(chunk.value).toString('utf8') } }
      finally { await reader.cancel() }
      return JSON.parse(text)
    }
  }
  const target = new URL(record.target)
  const nextTarget = newTarget ? new URL(newTarget) : target
  if (nextTarget.protocol !== 'http:' || nextTarget.hostname !== '127.0.0.1' || !nextTarget.port || nextTarget.pathname !== '/' || nextTarget.search || nextTarget.hash || nextTarget.username || nextTarget.password) throw Error('cloudpub-target')
  for (let page = 1; page <= 10; page++) {
    const result = await api('/api/endpoint/publications/?page=' + page + '&page_size=100')
    if (!Array.isArray(result.results)) throw Error('cloudpub-api-response')
    const publication = result.results.find((item: any) => item.guid === record.id)
    if (publication) {
      const valid = (item: any) => item.guid === record.id && (!publication.agent?.guid || item.agent?.guid === publication.agent.guid) && Number.isInteger(item.id) && item.id > 0 && ['127.0.0.1', 'localhost'].includes(item.local_addr) && item.local_port === Number(target.port) && String(item.local_proto).toLowerCase() === 'http'
      if (!valid(publication)) throw Error('cloudpub-ownership')
      // Re-read the exact object immediately before mutation. Do not send ACL/auth defaults.
      const current = await api('/api/endpoint/publications/' + publication.id + '/')
      if (!valid(current)) throw Error('cloudpub-ownership')
      if (current.remote_addr !== host || current.local_port !== Number(nextTarget.port)) {
        const updated = await api('/api/endpoint/publications/' + publication.id + '/', 'PATCH', { remote_addr: host, description: name, ...(current.local_port !== Number(nextTarget.port) ? { local_port: Number(nextTarget.port) } : {}) })
        if (updated.remote_addr !== host) throw Error('cloudpub-hostname-response')
      }
      return 'https://' + host
    }
    if (!result.next) break
  }
  throw Error('cloudpub-api-publication')
}
