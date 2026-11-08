/** Ordinary crossfade only. Fade-through-black and unrelated effects stay cuts.
 * https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-add-transitions-between-slides-in-a-presentation
 */
export function pptxFadeDuration(xml: string): number {
  const transition = xml.match(/<p:transition\b([^>]*)>([\s\S]*?)<\/p:transition>/)
  if (!transition || !/<p:fade\b/.test(transition[2]) || /thruBlk="(?:1|true)"/.test(transition[2])) return 0
  const duration = transition[1].match(/\bp14:dur="(\d+)"/)
  if (duration) return Math.max(0, Math.min(10000, Number(duration[1])))
  // Legacy speed is not an exact duration. Use the accepted CueDeck default.
  return 400
}
