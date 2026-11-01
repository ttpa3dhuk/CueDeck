import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  ACK_HEADER_BYTES,
  STATUS_PROTOCOL_ERROR,
  STATUS_PUBLISHED,
  STATUS_READY,
  decodeAck,
  encodeFrameHeader,
  type AckHeader,
} from '../src/main/syphon-bridge-protocol'

const HELPER = resolve('native/syphon-probe/build/CueDeckSyphonHelper')
const execFileAsync = promisify(execFile)
const available = existsSync(HELPER)
const suite = available ? describe : describe.skip

interface Running {
  child: ChildProcessWithoutNullStreams
  stderr: () => string
}

function startHelper(): Running {
  const child = spawn(HELPER, ['serve', '--name', 'CueDeck Syphon Helper Test', '--private', '--timeout-ms', '2000'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  return { child, stderr: () => stderr }
}

function readAck(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<AckHeader> {
  return new Promise((resolveAck, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout waiting for helper ack'))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < ACK_HEADER_BYTES) return
      try {
        const ack = decodeAck(buffer.subarray(0, ACK_HEADER_BYTES))
        cleanup()
        resolveAck(ack)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`helper exited before ack: ${code}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

function waitExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout waiting for helper exit'))
    }, timeoutMs)
    const onExit = (code: number | null): void => {
      cleanup()
      resolveExit(code)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

async function writeChunks(child: ChildProcessWithoutNullStreams, data: Buffer, sizes: number[]): Promise<void> {
  let offset = 0
  for (const size of sizes) {
    if (offset >= data.length) break
    const end = Math.min(data.length, offset + size)
    child.stdin.write(data.subarray(offset, end))
    offset = end
    await new Promise<void>((resolveDelay) => setImmediate(resolveDelay))
  }
  if (offset < data.length) child.stdin.write(data.subarray(offset))
}

function fixture(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      bytes[i] = (x * 3) & 0xff
      bytes[i + 1] = (y * 3) & 0xff
      bytes[i + 2] = (x + y) & 0xff
      bytes[i + 3] = 255
    }
  }
  return bytes
}

suite('native helper binary protocol', () => {
  it('accepts a fragmented valid frame and exits cleanly on EOF', async () => {
    const run = startHelper()
    try {
      expect(await readAck(run.child)).toMatchObject({ status: STATUS_READY, frameId: 0 })
      const width = 64
      const height = 64
      const payload = fixture(width, height)
      const header = encodeFrameHeader({
        width, height, stride: width * 4, payloadLength: payload.length,
        frameId: 1, premultiplied: true, origin: 'top-left',
      })
      await writeChunks(run.child, Buffer.concat([header, payload]), [1, 7, 13, 3, 128, 1024])
      const ack = await readAck(run.child)
      expect(ack.status).toBe(STATUS_PUBLISHED)
      expect(ack.frameId).toBe(1)
      run.child.stdin.end()
      expect(await waitExit(run.child)).toBe(0)
    } catch (error) {
      run.child.kill('SIGKILL')
      throw new Error(`${(error as Error).message}\nhelper stderr:\n${run.stderr()}`)
    }
  })

  it('rejects a corrupt header explicitly and does not publish', async () => {
    const run = startHelper()
    try {
      expect((await readAck(run.child)).status).toBe(STATUS_READY)
      const corrupt = Buffer.alloc(40)
      corrupt.write('NOPE', 0, 'ascii')
      run.child.stdin.write(corrupt)
      const ack = await readAck(run.child)
      expect(ack.status).toBe(STATUS_PROTOCOL_ERROR)
      expect(await waitExit(run.child)).toBe(1)
    } catch (error) {
      run.child.kill('SIGKILL')
      throw new Error(`${(error as Error).message}\nhelper stderr:\n${run.stderr()}`)
    }
  })

  it('detects a short header/EOF without waiting forever', async () => {
    const run = startHelper()
    try {
      expect((await readAck(run.child)).status).toBe(STATUS_READY)
      run.child.stdin.write(Buffer.alloc(10))
      run.child.stdin.end()
      expect(await waitExit(run.child)).toBe(1)
      expect(run.stderr()).toMatch(/short header/)
    } catch (error) {
      run.child.kill('SIGKILL')
      throw new Error(`${(error as Error).message}\nhelper stderr:\n${run.stderr()}`)
    }
  })

  it('stops on SIGTERM without waiting for another frame', async () => {
    const run = startHelper()
    try {
      expect((await readAck(run.child)).status).toBe(STATUS_READY)
      run.child.kill('SIGTERM')
      expect(await waitExit(run.child, 3000)).toBe(0)
    } catch (error) {
      run.child.kill('SIGKILL')
      throw new Error(`${(error as Error).message}\nhelper stderr:\n${run.stderr()}`)
    }
  })

  it('private selftest checks both input origins, alpha and explicit Y flip', async () => {
    for (const flip of ['0', '1']) {
      const result = await execFileAsync(HELPER, ['selftest', '--flip-y', flip], { timeout: 10000 })
      expect(result.stdout).toContain('SELFTEST PASS')
      expect(result.stdout).toContain(`flipY=${flip}`)
      expect(result.stdout).toContain('Metal client')
    }
  })
  it('detects a short payload without publishing it', async () => {
    const run = startHelper()
    try {
      expect((await readAck(run.child)).status).toBe(STATUS_READY)
      const width = 32
      const height = 32
      const payload = fixture(width, height)
      const header = encodeFrameHeader({
        width, height, stride: width * 4, payloadLength: payload.length,
        frameId: 3, premultiplied: true, origin: 'top-left',
      })
      run.child.stdin.write(header)
      run.child.stdin.write(payload.subarray(0, 100))
      run.child.stdin.end()
      expect(await waitExit(run.child)).toBe(1)
      expect(run.stderr()).toMatch(/short payload/)
    } catch (error) {
      run.child.kill('SIGKILL')
      throw new Error(`${(error as Error).message}\nhelper stderr:\n${run.stderr()}`)
    }
  })

})
