import type { DisplayMap, Layout, Role } from './types'

/** Fullscreen outputs must never cover the operator, including stale saved maps. */
export function safeDisplayLayout(
  layout: Layout,
  current: DisplayMap,
  displays: { id: number; internal?: boolean }[],
  audienceWindowed = false,
): { layout: Layout; displayMap: DisplayMap } {
  const exists = (id: number | undefined) => displays.some(d => d.id === id)
  const operator = exists(current.operator) ? current.operator! :
    (displays.find(d => d.internal) ?? displays[0])?.id
  if (operator === undefined) return { layout: 'solo', displayMap: {} }
  const external = displays.filter(d => d.id !== operator)
  const map: DisplayMap = { operator }
  if (!external.length && layout !== 'solo') {
    // Only the fullscreen prompter is unsafe here. Keep a requested audience
    // window, including when the user selected three roles before unplugging.
    if (!audienceWindowed) return { layout: 'solo', displayMap: map }
    layout = 'presenter-audience'
  }
  const roles: Role[] = layout === 'solo' ? [] :
    layout === 'presenter-audience' ? ['audience'] : ['speaker', 'audience']
  // Reserve valid explicit assignments before assigning newly enabled roles.
  for (const role of roles) {
    if (exists(current[role]) && (current[role] !== operator || (role === 'audience' && audienceWindowed))) {
      map[role] = current[role]
    }
  }
  for (const role of roles) {
    if (map[role] !== undefined) continue
    map[role] = (external.find(d => !Object.values(map).includes(d.id)) ?? external[0])?.id ?? operator
  }
  return { layout, displayMap: map }
}
