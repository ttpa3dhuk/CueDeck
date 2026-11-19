/**
 * Только одна рабочая dev-сборка. Запускается перед `npm run dev`: убивает
 * прежние Electron и electron-vite этого репозитория и ждёт, пока они уйдут.
 * Обычный SIGTERM dev-сборка игнорирует — поэтому -9.
 */
const { execFileSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const path = require('node:path')

if (process.platform === 'win32') process.exit(0)

const root = path.join(__dirname, '..')
const paths = [`${root}/node_modules/electron/dist`, `${root}/node_modules/.bin/electron-vite`]
// Worktrees can share node_modules through a symlink. Electron's process uses
// the resolved executable path, while electron-vite can keep the lexical path.
for (const candidate of [...paths]) {
  try { paths.push(realpathSync(candidate)) } catch { /* dependencies not installed */ }
}
const patterns = [...new Set(paths)].map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const alive = () =>
  patterns.some((p) => {
    try {
      execFileSync('pgrep', ['-f', p], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })

if (alive()) {
  for (const p of patterns) {
    try {
      execFileSync('pkill', ['-9', '-f', p], { stdio: 'ignore' })
    } catch {
      // уже нет
    }
  }
  const until = Date.now() + 5000
  while (alive() && Date.now() < until) execFileSync('sleep', ['0.2'])
  if (alive()) {
    console.error('⚠ прежняя dev-сборка CueDeck не закрылась — вторую не запускаю')
    process.exit(1)
  }
  console.log('Прежняя dev-сборка закрыта — запускаю одну новую.')
}
