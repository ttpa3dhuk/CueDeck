/**
 * Шрифты, которые идут вместе с Windows и Office. На маке их нет, но просить
 * их у заказчика бессмысленно: их ставят сами (Aptos — бесплатно с сайта
 * Microsoft). Оператору в окошке про шрифты подписываем такие, чтобы он не
 * гонялся за ними, а в текст для заказчика они не попадают.
 */
const MS_FONT_PREFIXES = [
  'aptos',
  'calibri',
  'cambria',
  'candara',
  'consolas',
  'constantia',
  'corbel',
  'segoe',
  'bahnschrift',
  'cascadia',
  'franklingothic',
  'centurygothic',
  'gillsansmt',
  'rockwell',
  'twcenmt',
  'lucidasans',
  'malgungothic',
  'microsoft',
  'yugothic',
  'meiryo',
]

export function isMicrosoftFont(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return MS_FONT_PREFIXES.some((p) => n.startsWith(p))
}
