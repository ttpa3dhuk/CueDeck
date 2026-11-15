import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { getLang, t } from '../shared/i18n.js'
import type { MobileClickerSnapshot, MobileClickerStatus, ClickerInvitation } from '../shared/mobile-clicker.js'
import type { MobileClickerStorage } from './mobile-clicker-storage.js'
import type { CloudpubTunnel } from './cloudpub.js'

/** Public HTTP runs in a separate OS process. Only bounded, validated commands enter main. */
export class MobileClickerService {
  private worker: UtilityProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private sequence = 0
  private epoch = 0
  private enabled = false
  private controls = 0
  private executing = false
  private lastCommand = 0
  private closed = false
  private cloudpub: NonNullable<MobileClickerStatus['cloudpub']> = { state: 'idle', message: null }
  private cloudSequence = 0
  private cloudTask: Promise<MobileClickerStatus> | null = null
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private snapshot: () => MobileClickerSnapshot, private command: (direction: 'next' | 'prev') => void | Promise<void>, private storage: MobileClickerStorage, private tunnel?: CloudpubTunnel) {}
  private start(): UtilityProcess {
    if (this.closed) throw Error('Clicker disposed')
    if (this.worker) return this.worker
    const worker = utilityProcess.fork(join(__dirname, 'mobile-clicker-worker.js'), [], { serviceName: 'CueDeck Mobile Clicker', stdio: 'ignore', execArgv: ['--max-old-space-size=96'] })
    this.worker = worker
    const send = (message: unknown): void => {
      if (this.worker !== worker) return
      try { worker.postMessage(message) } catch { /* An exiting network worker must not interrupt the operator. */ }
    }
    const publish = () => send({ type: 'snapshot', data: this.snapshot(), epoch: this.epoch, lang: getLang() })
    this.timer = setInterval(publish, 250); publish()
    worker.on('exit', () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null; this.worker = null; this.enabled = false; this.epoch++
      if (!this.closed) {
        this.cloudSequence++; this.tunnel?.cancel()
        this.cloudpub = { state: 'error', message: t('Сервер кликера остановлен; включите его заново') }
        void this.tunnel?.stop().catch(() => { this.cloudpub = { state: 'error', message: t('Онлайн вход закрыт, но CLOUDPUB не подтвердил остановку публикации') } })
      }
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error(t('Сервер кликера остановлен; включите его заново'))) }
      this.pending.clear()
    })
    worker.on('message', async message => {
      if (message.type === 'result') {
        const item = this.pending.get(message.id)
        if (item) { clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(Error(message.error)) : item.resolve(message.data) }
        return
      }
      try {
        let data: unknown
        if (message.type === 'load') data = await this.storage.load()
        else if (message.type === 'save') await this.storage.save(message.data)
        else if (message.type === 'command') {
          const value = message.data
          const fresh = this.snapshot()
          if (!this.enabled || this.controls > 0 || this.executing || value.epoch !== this.epoch || value.presentationId !== fresh.presentationId || !fresh.canNavigate || !['next', 'prev'].includes(value.direction) || Date.now() - this.lastCommand < 200) throw Error('Clicker unavailable')
          this.executing = true; this.lastCommand = Date.now()
          try { await this.command(value.direction) } finally { this.executing = false }
          publish()
        } else return
        send({ type: 'reply', id: message.id, data })
      } catch (error) { send({ type: 'reply', id: message.id, error: String(error) }) }
    })
    return worker
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.pending.size >= 16) return Promise.reject(Error('Clicker busy'))
    const worker = this.start(); const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Clicker timeout')) }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      try { worker.postMessage({ type: 'call', id, method, args }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error) }
    })
  }
  async status(): Promise<MobileClickerStatus> { return { ...await this.call<MobileClickerStatus>('status'), cloudpub: { ...this.cloudpub } } }
  qr(index: number): Promise<string | null> { return this.call('qr', index) }
  private async control<T>(method: string, ...args: unknown[]): Promise<T> {
    this.controls++; this.epoch++
    try { return await this.call<T>(method, ...args) }
    finally { this.controls--; this.epoch++ }
  }
  async setEnabled(value?: boolean): Promise<MobileClickerStatus> {
    this.enabled = false
    const result = await this.control<MobileClickerStatus>('enabled', value)
    this.enabled = result.enabled
    if (value === undefined && result.online && await this.tunnel?.configured()) return this.connectCloudpub()
    return result
  }
  resetLink(): Promise<MobileClickerStatus> { return this.control('reset') }
  async configure(online: boolean, url: string): Promise<MobileClickerStatus> {
    if (!online) {
      this.cloudSequence++; this.tunnel?.cancel()
      const current = await this.call<MobileClickerStatus>('status')
      let saveError: unknown
      if (current.target) await this.control('configure', false, '').catch(error => { saveError = error })
      if (this.cloudTask) await this.cloudTask.catch(() => undefined)
      try { await this.tunnel?.stop(); this.cloudpub = { state: 'idle', message: null } }
      catch { this.cloudpub = { state: 'error', message: t('Онлайн вход закрыт, но CLOUDPUB не подтвердил остановку публикации') } }
      if (saveError) throw saveError
      return this.status()
    }
    await this.tunnel?.useManualMode()
    this.cloudpub = { state: 'idle', message: null }
    return this.control('configure', true, url)
  }
  connectCloudpub(executable?: string): Promise<MobileClickerStatus> {
    if (!this.tunnel || this.closed) return Promise.reject(Error(t('Автонастройка CLOUDPUB недоступна')))
    if (this.cloudTask) return this.cloudTask
    const sequence = ++this.cloudSequence
    const active = () => { if (this.closed || sequence !== this.cloudSequence) throw Error('cloudpub-cancelled') }
    this.cloudpub = { state: 'connecting', message: null }
    const operation = (async () => {
      try {
        let status = await this.call<MobileClickerStatus>('status')
        if (!status.target) status = await this.setEnabled(true)
        active()
        await this.control('configure', false, status.publicUrl ?? '')
        await this.tunnel!.connect(status.target!, async url => {
          active()
          await this.control('configure', true, url)
          const nonce = await this.call<string>('connectionProbe')
          try {
            let verified = false
            for (let attempt = 0; attempt < 3 && !verified; attempt++) {
              active()
              try {
                const response = await fetch(url + '/.well-known/cuedeck-clicker/' + nonce, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' })
                const reader = response.body?.getReader(); let text = ''; let bytes = 0
                if (!response.ok || !reader) { await response.body?.cancel(); throw Error('cloudpub-probe') }
                try {
                  while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024) throw Error('cloudpub-probe'); text += Buffer.from(chunk.value).toString('utf8') }
                  verified = JSON.parse(text).nonce === nonce
                } finally { await reader.cancel() }
              } catch { /* Retry only this bounded, credential-free handshake. */ }
              if (!verified && attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000))
            }
            active()
            if (!verified) throw Error('cloudpub-probe')
          } finally { await this.call('clearProbe').catch(() => undefined) }
        }, executable)
        active(); this.cloudpub = { state: 'connected', message: t('CLOUDPUB подключён: внешний доступ проверен') }
      } catch (error) {
        await this.control('configure', false, '').catch(() => undefined)
        this.cloudpub = { state: 'error', message: String(error).includes('cloudpub-cleanup')
          ? t('Онлайн вход закрыт, но CLOUDPUB не подтвердил остановку публикации') : /cloudpub-hostname|cloudpub-api/.test(String(error))
          ? t('Не удалось назначить адрес cuedeck-код.cloudpub.ru. Проверьте аккаунт CLOUDPUB и доступность поддомена') : String(error).includes('cloudpub-not-found')
          ? t('CLOUDPUB не найден. Укажите установленный cloudpub.exe или clo.exe')
          : t('Не удалось подключить CLOUDPUB. Откройте его, войдите в аккаунт и повторите подключение') }
      }
      return this.status()
    })()
    this.cloudTask = operation
    void operation.finally(() => { this.cloudTask = null }).catch(() => undefined)
    return operation
  }
  createGrant(name: string, ids: string[] | null): Promise<MobileClickerStatus> { return this.call('createGrant', name, ids) }
  revokeGrant(id: string): Promise<MobileClickerStatus> { return this.control('revokeGrant', id) }
  updateGrant(id: string, ids: string[] | null): Promise<MobileClickerStatus> { return this.control('updateGrant', id, ids) }
  blockClient(id: string, blocked: boolean): Promise<MobileClickerStatus> { return this.control('blockClient', id, blocked) }
  approveClient(id: string, ids: string[] | null): Promise<MobileClickerStatus> { return this.control('approveClient', id, ids) }
  setGuestAccess(open: boolean, ids: string[] | null): Promise<MobileClickerStatus> { return this.control('guestAccess', open, ids) }
  disconnectClient(id: string): Promise<MobileClickerStatus> { return this.control('disconnectClient', id) }
  invitation(id: string): Promise<ClickerInvitation> { return this.call('invitation', id) }
  async dispose(): Promise<void> {
    this.closed = true; this.enabled = false
    this.cloudSequence++; this.tunnel?.cancel()
    if (this.cloudTask) await this.cloudTask.catch(() => undefined)
    await this.tunnel?.stop().catch(() => undefined)
    if (this.timer) clearInterval(this.timer)
    const worker = this.worker
    if (worker) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2000)
      worker.once('exit', () => { clearTimeout(timer); resolve() }); worker.kill()
    })
  }
}
