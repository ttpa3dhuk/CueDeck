import type { DisplayMap, Layout, Role } from '../shared/types.js'

export type { DisplayMap, Layout, Role } from '../shared/types.js'

export function rolesForLayout(layout: Layout): Role[] {
  switch (layout) {
    case 'solo':
      return ['operator']
    case 'presenter-audience':
      return ['operator', 'audience']
    case 'operator-speaker-audience':
      return ['operator', 'speaker', 'audience']
  }
}

export function defaultLayoutForDisplayCount(count: number): Layout {
  if (count <= 1) return 'solo'
  if (count === 2) return 'presenter-audience'
  return 'operator-speaker-audience'
}

export function autoAssignDisplays(
  layout: Layout,
  displays: { id: number; internal: boolean }[],
): DisplayMap {
  const internal = displays.find((d) => d.internal) ?? displays[0]
  const externals = displays.filter((d) => d.id !== internal.id)
  const map: DisplayMap = { operator: internal.id }

  if (layout === 'presenter-audience') {
    map.audience = externals[0]?.id ?? internal.id
  } else if (layout === 'operator-speaker-audience') {
    map.speaker = externals[0]?.id ?? internal.id
    map.audience = externals[1]?.id ?? externals[0]?.id ?? internal.id
  }

  return map
}
