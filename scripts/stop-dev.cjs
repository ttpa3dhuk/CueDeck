/**
 * Только одна рабочая dev-сборка. Запускается перед `npm run dev`: убивает
 * прежние Electron и electron-vite этого репозитория и ждёт, пока они уйдут.
 * Обычный SIGTERM dev-сборка игнорирует — поэтому -9.
 */
const { execSync } = require('node:child_process')
const path = require('node:path')

if (process.platform === 'win32') process.exit(0)

const root = path.join(__dirname, '..')
const patterns = [`${root}/node_modules/electron/dist`, `${root}/node_modules/.bin/electron-vite`]
const alive = () =>
  patterns.some((p) => {
    try {
      execSync(`pgrep -f ${JSON.stringify(p)}`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })

if (alive()) {
  for (const p of patterns) {
    try {
      execSync(`pkill -9 -f ${JSON.stringify(p)}`, { stdio: 'ignore' })
    } catch {
      // уже нет
    }
  }
  const until = Date.now() + 5000
  while (alive() && Date.now() < until) execSync('sleep 0.2')
  if (alive()) {
    console.error('⚠ прежняя dev-сборка CueDeck не закрылась — вторую не запускаю')
    process.exit(1)
  }
  console.log('Прежняя dev-сборка закрыта — запускаю одну новую.')
}
