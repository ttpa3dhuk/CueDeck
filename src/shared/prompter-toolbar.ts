/** Верхняя информационная панель суфлёра: 100–400%, шаг 10%. */
export function sanitizeSpeakerToolbarScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.round(Math.min(4, Math.max(1, value)) * 10) / 10
}
