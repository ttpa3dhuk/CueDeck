import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PreparationErrorCode } from '../shared/presentation-preparation.js'
import { windowsConversionCommand } from './presentation-preparation-windows.js'

/**
 * Параметры экспорта, которые влияют на число и вид страниц CueDeck.
 * Строка намеренно совпадает с прежней: PDF-экспорт LibreOffice и manifest v7
 * должны остаться прежними.
 */
export const PDF_EXPORT_FILTER = 'pdf:impress_pdf_Export:' + JSON.stringify({
  ExportHiddenSlides: { type: 'boolean', value: 'false' },
  ExportNotesPages: { type: 'boolean', value: 'false' },
  ExportNotes: { type: 'boolean', value: 'false' },
  ReduceImageResolution: { type: 'boolean', value: 'false' },
})

export class ConversionError extends Error {
  constructor(
    readonly code: Extract<PreparationErrorCode, 'cancelled' | 'timeout' | 'libreoffice_missing' | 'io'>,
    message: string,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

export interface ConvertToPdfOptions {
  sofficePath: string | null
  /** Приватная копия исходника (оригинал не трогаем). */
  sourcePath: string
  /** Куда LibreOffice кладёт PDF; сюда же пишется временный вывод. */
  outputDir: string
  /** Уникальный профиль текущего job, не пользовательский LibreOffice. */
  profileDir: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Задержка ожидания закрытия после kill; нужна для честного bounded cancel. */
  killGraceMs?: number
  log?: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void
  /** Только для тестов: подменить spawn. */
  spawnImpl?: typeof spawn
}

/**
 * Запускает контролируемый LibreOffice и возвращает путь созданного PDF.
 * Не читает настройки приложения: путь к soffice и профиль переданы снаружи.
 *
 * Отмена/таймаут убивают только живой child текущего job. На POSIX child
 * запускается в отдельной process group, поэтому SIGKILL забирает и soffice.bin.
 * Windows uses a supervisor with a non-inheritable KILL_ON_JOB_CLOSE Job Object.
 */
export async function convertSourceToPdf(options: ConvertToPdfOptions): Promise<string> {
  const {
    sofficePath, sourcePath, outputDir, profileDir, timeoutMs, signal,
    killGraceMs = 2_000, log = () => undefined, spawnImpl = spawn,
  } = options
  if (!sofficePath) {
    return Promise.reject(new ConversionError('libreoffice_missing', 'LibreOffice not found')) // i18n-ok: worker/main error
  }
  if (signal?.aborted) {
    return Promise.reject(new ConversionError('cancelled', 'Preparation cancelled')) // i18n-ok: worker/main error
  }

  const converterArgs = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless', '--norestore', '--nologo', '--nofirststartwizard',
    '--convert-to', PDF_EXPORT_FILTER, '--outdir', outputDir, sourcePath,
  ]
  const command = process.platform === 'win32'
    ? await windowsConversionCommand(sofficePath, converterArgs, profileDir)
    : { executable: sofficePath, args: converterArgs }
  if (signal?.aborted) throw new ConversionError('cancelled', 'Preparation cancelled')

  return new Promise<string>((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawnImpl(command.executable, command.args, {
        // На POSIX отдельная группа позволяет погасить и дочерний soffice.bin.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new ConversionError('io', `Could not start LibreOffice: ${String(error)}`)) // i18n-ok: worker/main error
      return
    }
    // Drain progress output so a full pipe cannot stall the converter.
    proc.stdout?.on('data', () => undefined)

    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const closeWaiters: Array<() => void> = []

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const markClosed = (): void => {
      closed = true
      for (const waiter of closeWaiters.splice(0)) waiter()
    }
    const waitClosed = (ms: number): Promise<boolean> => {
      if (closed) return Promise.resolve(true)
      return new Promise((done) => {
        const waiter = (): void => { clearTimeout(graceTimer); done(true) }
        closeWaiters.push(waiter)
        graceTimer = setTimeout(() => {
          const at = closeWaiters.indexOf(waiter)
          if (at >= 0) closeWaiters.splice(at, 1)
          done(false)
        }, ms)
      })
    }
    const killChild = (): void => {
      if (!proc.pid) return
      if (process.platform !== 'win32') {
        try { process.kill(-proc.pid, 'SIGKILL') } catch { /* group may already be gone */ }
      }
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }
    const fail = (code: 'cancelled' | 'timeout' | 'io', message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      killChild()
      void waitClosed(killGraceMs).then((didClose) => {
        if (!didClose) log('warn', `soffice: процесс не подтвердил завершение after ${killGraceMs} ms (${code})`) // i18n-ok: журнал
        reject(new ConversionError(code, message))
      })
    }
    const onAbort = (): void => fail('cancelled', 'Preparation cancelled') // i18n-ok: worker/main error
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    proc.stderr?.on('data', (data: Buffer | string) => {
      stderr += String(data)
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384)
    })
    proc.on('error', (error) => fail('io', `Could not start LibreOffice: ${String(error)}`)) // i18n-ok: worker/main error
    proc.on('close', (code) => {
      markClosed()
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) {
        reject(new ConversionError('io', `LibreOffice exit ${code}: ${stderr.trim() || 'unknown error'}`))
        return
      }
        const generated = `${parse(sourcePath).name}.pdf`
      const pdf = join(outputDir, generated)
      if (!existsSync(pdf)) {
        reject(new ConversionError('io', 'LibreOffice did not create a PDF (the source may be damaged)')) // i18n-ok: worker/main error
        return
      }
      resolve(pdf)
    })

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => fail('timeout', `Preparation exceeded timeout ${timeoutMs} ms`), timeoutMs) // i18n-ok: worker/main error
    }
  })
}
