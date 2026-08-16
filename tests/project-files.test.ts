import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexFolder, pickBestCandidate, uniqueName } from '../src/main/project-files'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cuedeck-files-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('indexFolder', () => {
  it('индексирует файлы во вложенных папках по имени в нижнем регистре', async () => {
    await mkdir(join(dir, 'спикеры', 'день-2'), { recursive: true })
    await writeFile(join(dir, 'Ролик.MP4'), 'x')
    await writeFile(join(dir, 'спикеры', 'доклад.pdf'), 'x')
    await writeFile(join(dir, 'спикеры', 'день-2', 'итоги.pdf'), 'x')

    const index = await indexFolder(dir)
    expect(index.get('ролик.mp4')).toEqual([join(dir, 'Ролик.MP4')])
    expect(index.get('доклад.pdf')).toEqual([join(dir, 'спикеры', 'доклад.pdf')])
    expect(index.get('итоги.pdf')).toEqual([join(dir, 'спикеры', 'день-2', 'итоги.pdf')])
  })

  it('скрытые папки пропускаются, глубина ограничена', async () => {
    await mkdir(join(dir, '.backup'), { recursive: true })
    await writeFile(join(dir, '.backup', 'доклад.pdf'), 'x')
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'c', 'глубоко.pdf'), 'x')

    const index = await indexFolder(dir, { maxDepth: 1 })
    expect(index.has('доклад.pdf')).toBe(false)
    expect(index.has('глубоко.pdf')).toBe(false)
  })

  it('несуществующая папка не роняет — пустой индекс', async () => {
    expect((await indexFolder(join(dir, 'нет-такой'))).size).toBe(0)
  })
})

describe('pickBestCandidate', () => {
  it('берёт наименее вложенный путь (копии в подпапках проигрывают)', () => {
    const picked = pickBestCandidate([
      '/шоу/архив/2025/доклад.pdf',
      '/шоу/доклад.pdf',
      '/шоу/backup/доклад.pdf',
    ])
    expect(picked).toBe('/шоу/доклад.pdf')
  })
})

describe('uniqueName', () => {
  it('разводит одинаковые имена суффиксом, регистр не обманывает', () => {
    const taken = new Set<string>()
    expect(uniqueName('презентация.pdf', taken)).toBe('презентация.pdf')
    expect(uniqueName('Презентация.pdf', taken)).toBe('Презентация-2.pdf')
    expect(uniqueName('презентация.pdf', taken)).toBe('презентация-3.pdf')
  })

  it('файл без расширения тоже разводится', () => {
    const taken = new Set<string>()
    expect(uniqueName('README', taken)).toBe('README')
    expect(uniqueName('README', taken)).toBe('README-2')
  })
})
