/** Never guess between identically named windows or reuse an id with another title. */
export function resolveWindowSource<T extends { id: string; name: string }>(
  sources: readonly T[], name: string, id?: string,
): T | null {
  const exact = sources.find((s) => s.id === id && s.name === name)
  if (exact) return exact
  const matches = sources.filter((s) => s.name === name)
  return matches.length === 1 ? matches[0] : null
}
