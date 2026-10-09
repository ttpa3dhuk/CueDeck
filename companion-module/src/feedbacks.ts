import type { CompanionFeedbackDefinitions } from '@companion-module/base'
import type ModuleInstance from './main.js'

/** Палитра — как в CueDeck и на готовой странице (companion/build.ts). */
export const C = {
	black: 0x000000,
	white: 0xffffff,
	muted: 0x8b93a3,
	green: 0x3fce7c,
	greenBg: 0x1e7a45,
	yellow: 0xf5c14c,
	amberBg: 0x8a5a00,
	red: 0xe0524a,
	redBg: 0xb3261e,
	blinkRed: 0xcc0000,
} as const

type NoOptions = Record<string, never>

export type FeedbacksSchema = {
	offline: { type: 'boolean'; options: NoOptions }
	timer_color: { type: 'advanced'; options: NoOptions }
	timer_over: { type: 'boolean'; options: { blink: boolean } }
	timer_running: { type: 'boolean'; options: NoOptions }
	timer_fullscreen: { type: 'boolean'; options: NoOptions }
	blackout: { type: 'boolean'; options: NoOptions }
	stream_running: { type: 'boolean'; options: NoOptions }
	stream_warn: { type: 'boolean'; options: { blink: boolean } }
	omt_on: { type: 'boolean'; options: NoOptions }
	omt_program: { type: 'boolean'; options: NoOptions }
	omt_preview: { type: 'boolean'; options: NoOptions }
	video_playing: { type: 'boolean'; options: NoOptions }
	muted: { type: 'boolean'; options: NoOptions }
	video_loop: { type: 'boolean'; options: NoOptions }
	message_shown: { type: 'boolean'; options: NoOptions }
	last_slide: { type: 'boolean'; options: NoOptions }
	preview_loaded: { type: 'boolean'; options: NoOptions }
	entry_state: { type: 'boolean'; options: { entry: number; state: 'program' | 'preview' } }
}

/** Фаза мигания: полсекунды горит, полсекунды нет — как blink(500) на готовой странице. */
export const blinkOn = (now = Date.now()): boolean => Math.floor(now / 500) % 2 === 0

export function UpdateFeedbacks(self: ModuleInstance): void {
	const st = () => self.state

	const feedbacks: CompanionFeedbackDefinitions<FeedbacksSchema> = {
		offline: {
			type: 'boolean',
			name: 'CueDeck: no connection',
			description: 'CueDeck is closed, external control is off, or the network is down.',
			defaultStyle: { color: C.muted, bgcolor: C.black },
			options: [],
			callback: () => st() === null,
		},
		timer_color: {
			type: 'advanced',
			name: 'Timer: text colour as on the confidence monitor',
			description: 'Green → yellow → red as time runs out; grey without connection.',
			options: [],
			callback: () => {
				const s = st()
				if (!s) return { color: C.muted }
				if (s.timer.overtime) return { color: C.white }
				const color = { green: C.green, yellow: C.yellow, red: C.red }[s.timer.color]
				return color === undefined ? {} : { color }
			},
		},
		timer_over: {
			type: 'boolean',
			name: 'Timer: time is over',
			description: 'Countdown went below zero. With “Blink” the style flashes every half second.',
			defaultStyle: { bgcolor: C.blinkRed, color: C.white },
			options: [{ id: 'blink', type: 'checkbox', label: 'Blink', default: true }],
			callback: (fb) => !!st()?.timer.overtime && (!fb.options.blink || blinkOn()),
		},
		timer_running: {
			type: 'boolean',
			name: 'Timer: running',
			defaultStyle: { bgcolor: C.greenBg, color: C.white },
			options: [],
			callback: () => !!st()?.timer.running,
		},
		timer_fullscreen: {
			type: 'boolean',
			name: 'Timer: “timer only” on the confidence monitor',
			defaultStyle: { bgcolor: C.amberBg, color: C.white },
			options: [],
			callback: () => {
				const p = st()?.timer.position
				return p === 'full' || p === 'full-noflash'
			},
		},
		blackout: {
			type: 'boolean',
			name: 'Program: blackout is on',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [],
			callback: () => !!st()?.program.blackout,
		},
		stream_running: {
			type: 'boolean',
			name: 'Stream: broadcasting',
			description: 'Same colour as the STREAM button in CueDeck — red while live.',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [],
			callback: () => !!st()?.stream?.running,
		},
		stream_warn: {
			type: 'boolean',
			name: 'Stream: something is wrong',
			description:
				'A destination is reconnecting, no picture, or the network can’t keep up. With “Blink” the style flashes every half second.',
			defaultStyle: { bgcolor: C.amberBg, color: C.white },
			options: [{ id: 'blink', type: 'checkbox', label: 'Blink', default: true }],
			callback: (fb) => {
				const s = st()
				return !!s?.stream?.running && !!s.stream.warn && (!fb.options.blink || blinkOn())
			},
		},
		omt_on: {
			type: 'boolean',
			name: 'OMT Program output: enabled',
			description: 'The Program OMT output is on in CueDeck (Settings → OMT outputs).',
			defaultStyle: { color: C.white },
			options: [],
			callback: () => !!st()?.omt?.program?.on,
		},
		omt_program: {
			type: 'boolean',
			name: 'OMT Program output: on air in vMix',
			description: 'vMix has CueDeck’s Program OMT source on air — red lamp.',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [],
			callback: () => {
				const o = st()?.omt?.program
				return !!o?.on && !!o.program
			},
		},
		omt_preview: {
			type: 'boolean',
			name: 'OMT Program output: in preview in vMix',
			description: 'vMix has CueDeck’s Program OMT source in preview — green lamp.',
			defaultStyle: { bgcolor: C.greenBg, color: C.white },
			options: [],
			callback: () => {
				const o = st()?.omt?.program
				return !!o?.on && !!o.preview
			},
		},
		video_playing: {
			type: 'boolean',
			name: 'Video on air: playing',
			defaultStyle: { bgcolor: C.greenBg, color: C.white },
			options: [],
			callback: () => {
				const s = st()
				return !!s && s.video.active && s.video.playing
			},
		},
		muted: {
			type: 'boolean',
			name: 'Video on air: program audio muted',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [],
			callback: () => !!st()?.video.muted,
		},
		video_loop: {
			type: 'boolean',
			name: 'Video on air: loop is on',
			defaultStyle: { bgcolor: C.amberBg, color: C.white },
			options: [],
			callback: () => !!st()?.video.loop,
		},
		message_shown: {
			type: 'boolean',
			name: 'Speaker message: shown on the monitor',
			defaultStyle: { bgcolor: C.amberBg, color: C.white },
			options: [],
			callback: () => !!st()?.speakerMessage,
		},
		last_slide: {
			type: 'boolean',
			name: 'Program: last slide',
			defaultStyle: { bgcolor: C.amberBg, color: C.white },
			options: [],
			callback: () => {
				const s = st()
				return !!s && s.program.remaining === 0
			},
		},
		preview_loaded: {
			type: 'boolean',
			name: 'Preview: something is loaded (TAKE is possible)',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [],
			callback: () => !!st()?.preview.name,
		},
		entry_state: {
			type: 'boolean',
			name: 'Playlist: entry N is on air / in preview',
			description: 'Tally for speaker buttons: red — on air, green — in preview.',
			defaultStyle: { bgcolor: C.redBg, color: C.white },
			options: [
				{ id: 'entry', type: 'number', label: 'Entry №', default: 1, min: 1, max: 999, asInteger: true },
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'program',
					choices: [
						{ id: 'program', label: 'On air' },
						{ id: 'preview', label: 'In preview' },
					],
				},
			],
			callback: (fb) => {
				const s = st()
				if (!s) return false
				const n = Number(fb.options.entry)
				return (fb.options.state === 'preview' ? s.preview.playlistIndex : s.program.playlistIndex) === n
			},
		},
	}

	self.setFeedbackDefinitions(feedbacks)
}
