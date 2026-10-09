import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOTE_COMMANDS } from '../src/main/remote/commands'

/** Подставляет стартовые значения переменных кнопки: `$(local:n)` → `1`. */
function withLocals(url: string, locals: any[] = []): string {
  return url.replace(/\$\(local:([^)]+)\)/g, (_m, name) => {
    const lv = locals.find((l) => l.variableName === name)
    if (!lv) throw new Error(`нет переменной кнопки ${name} в ${url}`)
    return String(lv.options.startup_value.value)
  })
}

/** Адреса всех действий всех кнопок на всех страницах файла Companion. */
function urls(file: string): string[] {
  const cfg = JSON.parse(readFileSync(resolve(__dirname, '../companion', file), 'utf8'))
  const out: string[] = []
  for (const page of Object.values<any>(cfg.pages))
    for (const row of Object.values<any>(page.controls))
      for (const btn of Object.values<any>(row))
        for (const step of Object.values<any>(btn.steps ?? {}))
          for (const a of step.action_sets?.down ?? []) out.push(withLocals(String(a.options.url.value), btn.localVariables))
  return out
}

/** Команда есть в адресе: путь (или псевдоним) — начало адреса, дальше только аргумент. */
const covers = (url: string, path: string, arg: string): boolean => {
  const u = decodeURIComponent(url)
  return u === path || (arg !== 'none' && u.startsWith(path + '/'))
}

describe.each(['CueDeck.companionconfig', 'CueDeck.en.companionconfig'])('готовая страница %s', (file) => {
  const all = urls(file)

  it('каждая команда CueDeck есть хотя бы в одной кнопке', () => {
    const missing = REMOTE_COMMANDS.filter(
      (c) => !all.some((u) => [c.path, ...(c.aliases ?? [])].some((p) => covers(u, p, c.arg))),
    ).map((c) => c.path)
    expect(missing).toEqual([])
  })

  it('у команд с перечнем значений есть кнопка на каждое значение', () => {
    for (const c of REMOTE_COMMANDS.filter((x) => x.arg === 'enum')) {
      for (const v of c.values ?? [])
        expect(all.some((u) => u === `${c.path}/${v}`), `${c.path}/${v}`).toBe(true)
    }
  })

  it('у каждого onOff-варианта (toggle / on / off) есть кнопка', () => {
    // onOff-команда — та, у которой есть все три: base/toggle, base/on, base/off (video/toggle — просто пуск/пауза).
    const has = (p: string) => REMOTE_COMMANDS.some((x) => x.path === p)
    const bases = new Set(
      REMOTE_COMMANDS.filter((c) => /\/toggle$/.test(c.path))
        .map((c) => c.path.replace(/\/toggle$/, ''))
        .filter((b) => has(`${b}/on`) && has(`${b}/off`)),
    )
    expect(bases.size).toBeGreaterThan(0)
    for (const b of bases) {
      for (const v of ['toggle', 'on', 'off']) {
        const path = `${b}/${v}`
        const c = REMOTE_COMMANDS.find((x) => x.path === path)
        expect(c, path).toBeDefined()
        expect(all.some((u) => u === path || (v === 'toggle' && u === b)), path).toBe(true)
      }
    }
  })
})
