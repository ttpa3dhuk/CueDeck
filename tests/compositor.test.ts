import { expect, it, vi } from 'vitest'
import { configureCompositor } from '../src/main/compositor'

function commandLine(switches: Record<string, string | undefined> = {}) {
  return { getSwitchValue: (name: string) => switches[name] ?? '', appendSwitch: vi.fn() }
}

it('enables the Windows presentation path without replacing other GPU features', () => {
  const cli = commandLine({ 'enable-features': 'OtherFeature:param/value' })
  configureCompositor('win32', cli)
  expect(cli.appendSwitch).toHaveBeenCalledExactlyOnceWith('enable-features', 'OtherFeature:param/value,BufferQueue')
})

it.each(['darwin', 'linux'])('leaves %s presentation unchanged', platform => {
  const cli = commandLine()
  configureCompositor(platform, cli)
  expect(cli.appendSwitch).not.toHaveBeenCalled()
})

it.each([
  { 'enable-features': 'OtherFeature,BufferQueue' },
  { 'enable-features': 'BufferQueue<Trial' },
  { 'enable-features': 'BufferQueue:parameter/value' },
  { 'disable-features': 'OtherFeature, BufferQueue' },
])('respects an explicit feature configuration: %j', switches => {
  const cli = commandLine(switches)
  configureCompositor('win32', cli)
  expect(cli.appendSwitch).not.toHaveBeenCalled()
})

it('does not confuse a different feature with the Windows primary-plane setting', () => {
  const cli = commandLine({ 'enable-features': 'BufferQueuePerRenderPass' })
  configureCompositor('win32', cli)
  expect(cli.appendSwitch).toHaveBeenCalledExactlyOnceWith('enable-features', 'BufferQueuePerRenderPass,BufferQueue')
})
