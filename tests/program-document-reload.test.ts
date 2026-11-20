import { expect, it } from 'vitest'
import { shouldReloadPreviewDocument, shouldReloadProgramDocument } from '../src/renderer/shared/program-document-reload'

const same = { pdfPath: '/show/lotto.pptx', fileKind: 'pptx' as const }

it('reloads a newly prepared PPTX PDF even when the source path and SHA stay the same', () => {
  expect(shouldReloadProgramDocument(null, same, null)).toBe(true)
  expect(shouldReloadProgramDocument(same.pdfPath, same, { slideMedia: [] })).toBe(true)
  expect(shouldReloadProgramDocument(same.pdfPath, same, { pdfSha1: 'same-source-sha' })).toBe(true)
  expect(shouldReloadProgramDocument(same.pdfPath, same, { currentSlide: 2 })).toBe(false)
  expect(shouldReloadProgramDocument(same.pdfPath, same, { takeTransition: { id: 'slide', durationMs: 0, scope: 'slide' } })).toBe(false)
  expect(shouldReloadProgramDocument(same.pdfPath, { ...same, fileKind: 'video' }, { slideMedia: [] })).toBe(false)
  expect(shouldReloadProgramDocument(same.pdfPath, { ...same, fileKind: 'image' }, { pdfSha1: 'new' })).toBe(false)
})

it('reloads preview when two prepared decks share a source path but have different SHA identities', () => {
  const path = '/show/lotto.pptx'
  expect(shouldReloadPreviewDocument(path, 'lo-sha', { path, sha1: 'pp-sha' })).toBe(true)
  expect(shouldReloadPreviewDocument(path, 'pp-sha', { path, sha1: 'pp-sha' })).toBe(false)
})
