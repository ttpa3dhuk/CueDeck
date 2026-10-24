export const DEFAULT_TIMER_ADJUSTMENTS = [-5, -1, 1, 5]
/** Two subtract and two add buttons; sign belongs to the slot, magnitude is editable. */
export function timerAdjustments(value: unknown): number[] {
  const values = Array.isArray(value) ? value : []
  return DEFAULT_TIMER_ADJUSTMENTS.map((fallback, i) => {
    const magnitude = Math.floor(Math.abs(Number(values[i])))
    return Number.isFinite(magnitude) && magnitude >= 1 && magnitude <= 999
      ? magnitude * Math.sign(fallback) : fallback
  })
}
