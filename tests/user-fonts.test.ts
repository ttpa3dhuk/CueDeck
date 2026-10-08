import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addFonts, addedFontsCount, collectFontFiles, removeAddedFonts } from '../src/main/user-fonts'

let root: string
let src: string
let dest: string
let list: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cuedeck-fonts-'))
  src = join(root, 'принесли')
  dest = join(root, 'Library-Fonts')
  list = join(root, 'added-fonts.json')
  await mkdir(join(src, 'вложенная'), { recursive: true })
  await writeFile(join(src, 'Gotham-Book.otf'), 'a')
  await writeFile(join(src, 'вложенная', 'Gotham-Bold.TTF'), 'b')
  await writeFile(join(src, 'readme.txt'), 'не шрифт')
  await writeFile(join(src, '._Gotham-Book.otf'), 'служебный')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('collectFontFiles', () => {
  it('берёт шрифты из папки вглубь, пропускает чужие расширения и скрытое', async () => {
    const got = (await collectFontFiles([src])).map((p) => p.slice(src.length + 1)).sort()
    expect(got).toEqual(['Gotham-Book.otf', join('вложенная', 'Gotham-Bold.TTF')].sort())
  })
  it('отдельный файл шрифта берёт, не-шрифт отбрасывает', async () => {
    expect(await collectFontFiles([join(src, 'Gotham-Book.otf'), join(src, 'readme.txt')])).toHaveLength(1)
  })
})

describe('addFonts / removeAddedFonts', () => {
  it('копирует шрифты, ведёт список, убирает ровно их', async () => {
    const res = await addFonts([src], dest, list)
    expect(res.added).toHaveLength(2)
    expect(await addedFontsCount(list)).toBe(2)
    expect(await removeAddedFonts(dest, list)).toBe(2)
    expect(existsSync(join(dest, 'Gotham-Book.otf'))).toBe(false)
    expect(await addedFontsCount(list)).toBe(0)
  })

  it('чужой файл с тем же именем не перезаписывает и при «убрать» не удаляет', async () => {
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'Gotham-Book.otf'), 'мой собственный')
    const res = await addFonts([src], dest, list)
    expect(res.skipped).toEqual(['Gotham-Book.otf'])
    expect(res.added).toHaveLength(1)
    await removeAddedFonts(dest, list)
    expect(existsSync(join(dest, 'Gotham-Book.otf'))).toBe(true)
  })

  it('хуки: регистрация после копии, отказ системы — в failed, снятие регистрации до удаления', async () => {
    const calls: string[] = []
    const res = await addFonts([src], dest, list, {
      install: async (p) => {
        calls.push(`install ${p.split(/[\\/]/).pop()}`)
        if (p.endsWith('.TTF')) throw new Error('битый')
      },
    })
    expect(res.failed).toEqual(['Gotham-Bold.TTF'])
    expect(res.added).toHaveLength(2) // непринятый тоже в списке — «Убрать» его сотрёт
    await removeAddedFonts(dest, list, {
      uninstall: async (p) => {
        calls.push(`uninstall ${p.split(/[\\/]/).pop()} exists=${existsSync(p)}`)
      },
    })
    expect(calls.filter((c) => c.startsWith('uninstall')).every((c) => c.endsWith('exists=true'))).toBe(true)
    expect(existsSync(join(dest, 'Gotham-Bold.TTF'))).toBe(false)
  })

  it('испорченный список не стирает файлы вне папки шрифтов', async () => {
    const outside = join(root, 'важное.otf')
    await writeFile(outside, 'x')
    await writeFile(list, JSON.stringify([outside]))
    expect(await removeAddedFonts(dest, list)).toBe(0)
    expect(existsSync(outside)).toBe(true)
  })
})
