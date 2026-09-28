/**
 * Действие Companion → команда CueDeck. Без зависимостей от SDK: этот же файл
 * проверяют тесты CueDeck (tests/companion-module.test.ts) — каждая команда,
 * которую может отправить модуль, должна существовать в REMOTE_COMMANDS.
 *
 * Команда уходит как `GET /api/<path>?value=<value>`: аргумент всегда в
 * `?value=`, а не хвостом пути, чтобы текст со слэшем («Вопросы / ответы»)
 * доходил целиком.
 */

export interface Command {
	path: string
	value?: string
}

export const ON_OFF = ['toggle', 'on', 'off'] as const
export const VIDEO_CMDS = ['toggle', 'play', 'pause', 'restart', 'stop'] as const
export const PREVIEW_CMDS = ['next', 'prev', 'clear', 'video_toggle'] as const
export const TIMER_CMDS = ['toggle', 'start', 'pause', 'reset', 'restart', 'fullscreen'] as const
export const TIMER_MODES = ['countdown', 'stopwatch', 'clock'] as const
export const TIMER_POSITIONS = [
	'top-left',
	'top-right',
	'bottom-left',
	'bottom-right',
	'hidden',
	'full',
	'full-noflash',
	'free',
] as const

type Options = Record<string, unknown>

const str = (v: unknown): string =>
	typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
const int = (v: unknown, fallback = 1): string => {
	const n = Math.round(Number(v))
	return String(Number.isFinite(n) && n >= 1 ? n : fallback)
}
const oneOf = <T extends readonly string[]>(list: T, v: unknown, fallback: T[number]): T[number] => {
	const s = str(v)
	return (list as readonly string[]).includes(s) ? s : fallback
}

/** Вставленный из браузера путь бывает уже закодирован (`%D0%92…`) — не кодировать дважды. */
function safeDecode(seg: string): string {
	try {
		return decodeURIComponent(seg)
	} catch {
		return seg
	}
}

/** actionId + options → команда; null — действие не отправляет ничего (пустой ввод). */
export function commandFor(actionId: string, o: Options): Command | null {
	switch (actionId) {
		case 'program_next':
			return { path: 'program/next' }
		case 'program_prev':
			return { path: 'program/prev' }
		case 'program_goto':
			return { path: 'program/goto', value: int(o.slide) }
		case 'take':
			return { path: 'take' }
		case 'blackout':
			return { path: `blackout/${oneOf(ON_OFF, o.mode, 'toggle')}` }
		case 'stream':
			return { path: `stream/${oneOf(ON_OFF, o.mode, 'toggle')}` }

		case 'video': {
			const cmd = oneOf(VIDEO_CMDS, o.cmd, 'toggle')
			return { path: `video/${cmd}` }
		}
		case 'video_seek': {
			const sec = str(o.seconds) || '10'
			return { path: o.direction === 'back' ? 'video/back' : 'video/forward', value: sec }
		}
		case 'video_mute':
			return { path: `video/mute/${oneOf(ON_OFF, o.mode, 'toggle')}` }
		case 'video_loop':
			return { path: `video/loop/${oneOf(ON_OFF, o.mode, 'toggle')}` }

		case 'playlist_entry':
			return { path: o.target === 'air' ? 'playlist/air' : 'playlist/select', value: int(o.entry) }
		case 'playlist_step':
			return { path: o.direction === 'prev' ? 'playlist/prev' : 'playlist/next' }

		case 'preview': {
			const cmd = oneOf(PREVIEW_CMDS, o.cmd, 'next')
			return { path: cmd === 'video_toggle' ? 'preview/video/toggle' : `preview/${cmd}` }
		}
		case 'preview_goto':
			return { path: 'preview/goto', value: int(o.slide) }

		case 'timer': {
			const cmd = oneOf(TIMER_CMDS, o.cmd, 'toggle')
			return { path: cmd === 'fullscreen' ? 'timer/full' : `timer/${cmd}` }
		}
		case 'timer_set': {
			const d = str(o.duration)
			return d ? { path: 'timer/set', value: d } : null
		}
		case 'timer_adjust': {
			const d = str(o.amount)
			return d ? { path: o.direction === 'sub' ? 'timer/sub' : 'timer/add', value: d } : null
		}
		case 'timer_preset':
			return { path: 'timer/preset', value: int(o.preset) }
		case 'timer_mode':
			return { path: 'timer/mode', value: oneOf(TIMER_MODES, o.mode, 'countdown') }
		case 'timer_position':
			return { path: 'timer/position', value: oneOf(TIMER_POSITIONS, o.position, 'top-right') }

		case 'message_preset':
			return { path: 'message/preset', value: int(o.preset) }
		case 'message_text': {
			const t = str(o.text)
			return t ? { path: 'message/text', value: t } : null
		}
		case 'message_clear':
			return { path: 'message/clear' }

		case 'custom': {
			// «timer/set/20» или вставленный целиком URL из «Списка команд» CueDeck.
			const [raw, query] = str(o.path).split('?', 2)
			const p = raw
				.replace(/^https?:\/\/[^/]+/i, '')
				.replace(/^\/?(api|cuedeck)\//i, '')
				.replace(/^\/+/, '')
				.split('/')
				.map(safeDecode)
				.join('/')
			if (!p) return null
			const value = query ? new URLSearchParams(query).get('value') : null
			return value !== null ? { path: p, value } : { path: p }
		}
	}
	return null
}

/** URL команды относительно `http://host:port`. */
export function commandUrl(c: Command): string {
	const path = c.path
		.split('/')
		.filter(Boolean)
		.map((seg) => encodeURIComponent(seg))
		.join('/')
	return `/api/${path}${c.value !== undefined ? `?value=${encodeURIComponent(c.value)}` : ''}`
}
