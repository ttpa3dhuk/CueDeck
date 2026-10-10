import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    quit: vi.fn(),
    isInApplicationsFolder: vi.fn(),
    moveToApplicationsFolder: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(), showMessageBoxSync: vi.fn() },
}))
vi.mock('electron', () => electron)

const originalPlatform = process.platform
let install: typeof import('../src/main/mac-install.js')

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  electron.app.isPackaged = true
  electron.app.isInApplicationsFolder.mockReturnValue(false)
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
  install = await import('../src/main/mac-install.js')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

describe('Mac installation at startup', () => {
  it.each(['dev', 'installed', 'windows'])('skips the prompt for %s', async (kind) => {
    if (kind === 'dev') electron.app.isPackaged = false
    if (kind === 'installed') electron.app.isInApplicationsFolder.mockReturnValue(true)
    if (kind === 'windows') Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(await install.offerMacInstall()).toBe(false)
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.app.moveToApplicationsFolder).not.toHaveBeenCalled()
  })

  it('continues in place when the user declines', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    expect(await install.offerMacInstall()).toBe(false)
    expect(electron.app.moveToApplicationsFolder).not.toHaveBeenCalled()
  })

  it('stops startup and bypasses the quit guard during a successful native move', async () => {
    electron.app.moveToApplicationsFolder.mockImplementation(() => {
      expect(install.isMovingToApplications()).toBe(true)
      return true
    })
    expect(await install.offerMacInstall()).toBe(true)
    expect(install.isMovingToApplications()).toBe(true)
  })

  it('restores the ordinary quit guard if authorization is cancelled', async () => {
    electron.app.moveToApplicationsFolder.mockReturnValue(false)
    expect(await install.offerMacInstall()).toBe(false)
    expect(install.isMovingToApplications()).toBe(false)
  })

  it('replaces a closed installed copy without a second prompt', async () => {
    electron.app.moveToApplicationsFolder.mockImplementation(({ conflictHandler }) => {
      return conflictHandler('exists')
    })
    expect(await install.offerMacInstall()).toBe(true)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
  })

  it('quits the new copy when the user cancels waiting for the running copy', async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    electron.app.moveToApplicationsFolder.mockImplementation(({ conflictHandler }) => {
      return conflictHandler('existsAndRunning')
    })
    expect(await install.offerMacInstall()).toBe(true)
    expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(install.isMovingToApplications()).toBe(false)
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('retries in the same startup after the installed copy closes', async () => {
    electron.app.moveToApplicationsFolder
      .mockImplementationOnce(({ conflictHandler }) => conflictHandler('existsAndRunning'))
      .mockImplementationOnce(({ conflictHandler }) => conflictHandler('exists'))
    expect(await install.offerMacInstall()).toBe(true)
    expect(electron.app.moveToApplicationsFolder).toHaveBeenCalledTimes(2)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(install.isMovingToApplications()).toBe(true)
  })

  it('keeps waiting if the installed copy is still running on retry', async () => {
    electron.dialog.showMessageBox
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })
    electron.app.moveToApplicationsFolder.mockImplementation(({ conflictHandler }) => conflictHandler('existsAndRunning'))
    expect(await install.offerMacInstall()).toBe(true)
    expect(electron.app.moveToApplicationsFolder).toHaveBeenCalledTimes(2)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(3)
    expect(install.isMovingToApplications()).toBe(false)
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('reports a copy failure and continues with the quit guard restored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.app.moveToApplicationsFolder.mockImplementation(() => { throw new Error('copy failed') })
    expect(await install.offerMacInstall()).toBe(false)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(install.isMovingToApplications()).toBe(false)
  })
})
