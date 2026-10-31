/** Legacy presets remain valid; named families are stored without CSS syntax. */
export function timerFont(value: unknown, fallback = 'system'): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  return name.length > 0 && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name) ? name : fallback
}
export function timerFontCss(value: unknown): string {
  const name = timerFont(value)
  if (name === 'system') return 'system-ui, sans-serif'
  if (name === 'mono') return 'ui-monospace, "Cascadia Mono", Consolas, monospace'
  if (name === 'serif') return 'Georgia, "Times New Roman", serif'
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", system-ui, sans-serif`
}
