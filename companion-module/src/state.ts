/**
 * Состояние CueDeck (`GET /api/state`) → переменные модуля. Без зависимостей
 * от SDK, проверяется тестами CueDeck.
 *
 * Поля `playlist.names`, `next`, `timerPresets`, `messagePresets` появились в
 * CueDeck после 0.8.0 — с 0.7.0 модуль тоже работает, просто без имён спикеров на
 * кнопках и без текстов пресетов.
 */

export interface CueDeckState {
	ok: boolean
	app: string
	version: string
	timer: {
		text: string
		color: 'green' | 'yellow' | 'red' | 'neutral' | string
		overtime: boolean
		running: boolean
		mode: string
		position: string
		durationMs: number
		durationText: string
		elapsedMs: number
		remainingMs: number
	}
	program: {
		name: string | null
		kind: string | null
		slide: number | null
		total: number | null
		remaining: number | null
		text: string
		blackout: boolean
		playlistIndex: number | null
	}
	video: {
		active: boolean
		playing: boolean
		muted: boolean
		loop: boolean
		positionSec: number
		durationSec: number
		remainingText: string
	}
	preview: {
		name: string | null
		kind: string | null
		slide: number | null
		total: number | null
		playlistIndex: number | null
	}
	playlist: { count: number; names?: string[] }
	next?: { name: string | null; playlistIndex: number | null } | null
	speakerMessage: string | null
	timerPresets?: number[]
	messagePresets?: string[]
}

export type VarValue = string | number | boolean

/** Сколько кнопок «спикер N» / пресетов держать в переменных как минимум. */
export const MIN_SPEAKERS = 8
export const MIN_PRESETS = 4
const MAX_LIST = 99

/** Имя без расширения — на кнопке 72×72 каждая буква на счету. */
export function shortName(name: string | null | undefined): string {
	if (!name) return ''
	return name.replace(/\.[a-z0-9]{2,5}$/i, '')
}

const num = (v: number | null | undefined): number | '' => (typeof v === 'number' ? v : '')

export function speakerCount(s: CueDeckState | null): number {
	return Math.min(MAX_LIST, Math.max(MIN_SPEAKERS, s?.playlist.names?.length ?? s?.playlist.count ?? 0))
}

export function presetCounts(s: CueDeckState | null): { timer: number; message: number } {
	return {
		timer: Math.min(MAX_LIST, Math.max(MIN_PRESETS, s?.timerPresets?.length ?? 0)),
		message: Math.min(MAX_LIST, Math.max(MIN_PRESETS, s?.messagePresets?.length ?? 0)),
	}
}

/** Определения переменных: id → подпись в Companion (Variables). */
export function variableNames(s: CueDeckState | null): Record<string, string> {
	const out: Record<string, string> = {
		connected: 'CueDeck connected (true / false)',
		version: 'CueDeck version',
		timer: 'Timer as shown on the confidence monitor: 04:59, −00:12 (empty when offline)',
		timer_color: 'Timer colour: green / yellow / red / neutral',
		timer_over: 'Countdown is over, time is negative (true / false)',
		timer_running: 'Timer is running (true / false)',
		timer_mode: 'Timer mode: countdown / stopwatch / clock',
		timer_position: 'Timer position on the confidence monitor',
		timer_duration: 'Timer duration: 15:00',
		timer_remaining_s: 'Timer remaining, whole seconds (negative after zero)',
		slide: 'Slide on air: 3/12 (empty if nothing to page through)',
		slide_number: 'Slide number on air',
		slide_total: 'Total slides on air',
		slides_left: 'Slides left after the current one',
		program: 'On air: playlist entry or file name',
		program_index: 'On air: playlist entry number',
		preview: 'In preview — goes on air with TAKE',
		preview_index: 'In preview: playlist entry number',
		next: 'Entry that “next speaker” will put into preview',
		next_index: 'Next entry number',
		video_remaining: 'Video on air: time left, 00:13 (empty if no video)',
		video_playing: 'Video on air is playing (true / false)',
		muted: 'Program audio muted (true / false)',
		loop: 'Video on air loops (true / false)',
		blackout: 'Blackout / holding slide is on (true / false)',
		message: 'Message to the speaker on the confidence monitor (empty — none)',
		playlist_count: 'Number of playlist entries',
	}
	for (let i = 1; i <= speakerCount(s); i++) out[`speaker_${i}`] = `Playlist entry ${i}: name`
	const p = presetCounts(s)
	for (let i = 1; i <= p.timer; i++) out[`timer_preset_${i}`] = `Timer preset ${i}: minutes`
	for (let i = 1; i <= p.message; i++) out[`message_preset_${i}`] = `Speaker message preset ${i}: text`
	return out
}

/** Значения переменных; `s === null` — нет связи с CueDeck. */
export function variableValues(s: CueDeckState | null): Record<string, VarValue> {
	const names = variableNames(s)
	if (!s) {
		const off: Record<string, VarValue> = {}
		for (const k of Object.keys(names)) off[k] = ''
		return {
			...off,
			connected: false,
			timer_over: false,
			timer_running: false,
			video_playing: false,
			muted: false,
			loop: false,
			blackout: false,
		}
	}
	const v: Record<string, VarValue> = {
		connected: true,
		version: s.version ?? '',
		timer: s.timer.text,
		timer_color: s.timer.color,
		timer_over: s.timer.overtime,
		timer_running: s.timer.running,
		timer_mode: s.timer.mode,
		timer_position: s.timer.position,
		timer_duration: s.timer.durationText,
		timer_remaining_s: Math.trunc(s.timer.remainingMs / 1000),
		slide: s.program.text ?? '',
		slide_number: num(s.program.slide),
		slide_total: num(s.program.total),
		slides_left: num(s.program.remaining),
		program: shortName(s.program.name),
		program_index: num(s.program.playlistIndex),
		preview: shortName(s.preview.name),
		preview_index: num(s.preview.playlistIndex),
		next: shortName(s.next?.name),
		next_index: num(s.next?.playlistIndex),
		video_remaining: s.video.active ? s.video.remainingText : '',
		video_playing: s.video.active && s.video.playing,
		muted: s.video.muted,
		loop: s.video.loop,
		blackout: s.program.blackout,
		message: s.speakerMessage ?? '',
		playlist_count: s.playlist.count,
	}
	for (let i = 1; i <= speakerCount(s); i++) v[`speaker_${i}`] = shortName(s.playlist.names?.[i - 1])
	const p = presetCounts(s)
	for (let i = 1; i <= p.timer; i++) v[`timer_preset_${i}`] = s.timerPresets?.[i - 1] ?? ''
	for (let i = 1; i <= p.message; i++) v[`message_preset_${i}`] = s.messagePresets?.[i - 1] ?? ''
	return v
}

/** Только изменившиеся значения — Companion не нужно дёргать 4 раза в секунду всем списком. */
export function diffValues(next: Record<string, VarValue>, last: Map<string, VarValue>): Record<string, VarValue> {
	const out: Record<string, VarValue> = {}
	for (const [k, v] of Object.entries(next)) if (last.get(k) !== v) out[k] = v
	return out
}
