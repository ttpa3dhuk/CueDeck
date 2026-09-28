import type { CompanionActionDefinitions, DropdownChoice } from '@companion-module/base'
import { commandFor } from './commands.js'
import type ModuleInstance from './main.js'

type OnOff = 'toggle' | 'on' | 'off'

export type ActionsSchema = {
	program_next: { options: Record<string, never> }
	program_prev: { options: Record<string, never> }
	program_goto: { options: { slide: number } }
	take: { options: Record<string, never> }
	blackout: { options: { mode: OnOff } }
	stream: { options: { mode: OnOff } }
	video: { options: { cmd: string } }
	video_seek: { options: { direction: 'forward' | 'back'; seconds: number } }
	video_mute: { options: { mode: OnOff } }
	video_loop: { options: { mode: OnOff } }
	playlist_entry: { options: { entry: number; target: 'preview' | 'air' } }
	playlist_step: { options: { direction: 'next' | 'prev' } }
	preview: { options: { cmd: string } }
	preview_goto: { options: { slide: number } }
	timer: { options: { cmd: string } }
	timer_set: { options: { duration: string } }
	timer_adjust: { options: { direction: 'add' | 'sub'; amount: string } }
	timer_preset: { options: { preset: number } }
	timer_mode: { options: { mode: string } }
	timer_position: { options: { position: string } }
	message_preset: { options: { preset: number } }
	message_text: { options: { text: string } }
	message_clear: { options: Record<string, never> }
	custom: { options: { path: string } }
}

const onOffChoices: DropdownChoice<OnOff>[] = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
]

const DURATION_HELP = 'Minutes (15), min:sec (1:30), h:mm:ss (1:00:00) or with a unit: 90s, 5m, 1h'

export function UpdateActions(self: ModuleInstance): void {
	const run = async (actionId: string, options: Record<string, unknown>): Promise<void> => {
		const c = commandFor(actionId, options)
		if (c) await self.sendCommand(c)
	}

	const actions: CompanionActionDefinitions<ActionsSchema> = {
		// ── Эфир ──
		program_next: {
			name: 'Program: Next',
			description: 'Next slide on air, like the clicker. On a slide with a video the first “next” starts the video.',
			options: [],
			callback: async (e) => run(e.actionId, e.options),
		},
		program_prev: {
			name: 'Program: Previous',
			options: [],
			callback: async (e) => run(e.actionId, e.options),
		},
		program_goto: {
			name: 'Program: Go to slide',
			options: [{ id: 'slide', type: 'number', label: 'Slide', default: 1, min: 1, max: 9999, asInteger: true }],
			callback: async (e) => run(e.actionId, e.options),
		},
		take: {
			name: 'Program: TAKE (preview → air)',
			description: 'Sends what is in preview to the audience screen.',
			options: [],
			callback: async (e) => run(e.actionId, e.options),
		},
		blackout: {
			name: 'Program: Blackout / holding slide',
			options: [{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'toggle', choices: onOffChoices }],
			callback: async (e) => run(e.actionId, e.options),
		},
		stream: {
			name: 'Stream: Start / stop broadcast',
			description: 'Same as the STREAM button in CueDeck — sends to all enabled destinations set up in the app.',
			options: [{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'toggle', choices: onOffChoices }],
			callback: async (e) => run(e.actionId, e.options),
		},

		// ── Ролик в эфире ──
		video: {
			name: 'Video on air: Transport',
			options: [
				{
					id: 'cmd',
					type: 'dropdown',
					label: 'Command',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Play / pause' },
						{ id: 'play', label: 'Play' },
						{ id: 'pause', label: 'Pause' },
						{ id: 'restart', label: 'From the start and play' },
						{ id: 'stop', label: 'Stop (pause on the first frame)' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		video_seek: {
			name: 'Video on air: Skip',
			options: [
				{
					id: 'direction',
					type: 'dropdown',
					label: 'Direction',
					default: 'forward',
					choices: [
						{ id: 'forward', label: 'Forward' },
						{ id: 'back', label: 'Back' },
					],
				},
				{ id: 'seconds', type: 'number', label: 'Seconds', default: 10, min: 0.5, max: 3600, step: 0.5 },
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		video_mute: {
			name: 'Video on air: Mute program audio',
			options: [{ id: 'mode', type: 'dropdown', label: 'Mute', default: 'toggle', choices: onOffChoices }],
			callback: async (e) => run(e.actionId, e.options),
		},
		video_loop: {
			name: 'Video on air: Loop',
			options: [{ id: 'mode', type: 'dropdown', label: 'Loop', default: 'toggle', choices: onOffChoices }],
			callback: async (e) => run(e.actionId, e.options),
		},

		// ── Плейлист ──
		playlist_entry: {
			name: 'Playlist: Load entry N',
			description: 'N is the number shown on the playlist card in CueDeck.',
			options: [
				{ id: 'entry', type: 'number', label: 'Entry №', default: 1, min: 1, max: 999, asInteger: true },
				{
					id: 'target',
					type: 'dropdown',
					label: 'Where',
					default: 'preview',
					choices: [
						{ id: 'preview', label: 'Into preview' },
						{ id: 'air', label: 'Straight on air (skip preview)' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		playlist_step: {
			name: 'Playlist: Next / previous speaker into preview',
			options: [
				{
					id: 'direction',
					type: 'dropdown',
					label: 'Direction',
					default: 'next',
					choices: [
						{ id: 'next', label: 'Next speaker' },
						{ id: 'prev', label: 'Previous speaker' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},

		// ── Превью ──
		preview: {
			name: 'Preview: Control',
			options: [
				{
					id: 'cmd',
					type: 'dropdown',
					label: 'Command',
					default: 'next',
					choices: [
						{ id: 'next', label: 'Next slide' },
						{ id: 'prev', label: 'Previous slide' },
						{ id: 'video_toggle', label: 'Video play / pause' },
						{ id: 'clear', label: 'Clear preview' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		preview_goto: {
			name: 'Preview: Go to slide',
			options: [{ id: 'slide', type: 'number', label: 'Slide', default: 1, min: 1, max: 9999, asInteger: true }],
			callback: async (e) => run(e.actionId, e.options),
		},

		// ── Таймер ──
		timer: {
			name: 'Timer: Control',
			options: [
				{
					id: 'cmd',
					type: 'dropdown',
					label: 'Command',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Start / pause' },
						{ id: 'start', label: 'Start' },
						{ id: 'pause', label: 'Pause' },
						{ id: 'reset', label: 'Reset' },
						{ id: 'restart', label: 'Reset and start (next speaker)' },
						{ id: 'fullscreen', label: 'Timer only on the monitor ⛶ (flash ↔ no flash)' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		timer_set: {
			name: 'Timer: Set duration',
			options: [
				{
					id: 'duration',
					type: 'textinput',
					label: 'Duration',
					default: '15',
					description: DURATION_HELP,
					useVariables: true,
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		timer_adjust: {
			name: 'Timer: Add / subtract time',
			options: [
				{
					id: 'direction',
					type: 'dropdown',
					label: 'Direction',
					default: 'add',
					choices: [
						{ id: 'add', label: 'Add' },
						{ id: 'sub', label: 'Subtract' },
					],
				},
				{
					id: 'amount',
					type: 'textinput',
					label: 'Amount',
					default: '1',
					description: DURATION_HELP,
					useVariables: true,
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		timer_preset: {
			name: 'Timer: Duration preset N',
			description: 'The 5 / 10 / 15 / 20 buttons in CueDeck — minutes are set there.',
			options: [{ id: 'preset', type: 'number', label: 'Preset №', default: 1, min: 1, max: 99, asInteger: true }],
			callback: async (e) => run(e.actionId, e.options),
		},
		timer_mode: {
			name: 'Timer: Mode',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'countdown',
					choices: [
						{ id: 'countdown', label: 'Countdown' },
						{ id: 'stopwatch', label: 'Stopwatch' },
						{ id: 'clock', label: 'Clock' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		timer_position: {
			name: 'Timer: Position on the confidence monitor',
			options: [
				{
					id: 'position',
					type: 'dropdown',
					label: 'Position',
					default: 'top-right',
					choices: [
						{ id: 'top-left', label: 'Top left' },
						{ id: 'top-right', label: 'Top right' },
						{ id: 'bottom-left', label: 'Bottom left' },
						{ id: 'bottom-right', label: 'Bottom right' },
						{ id: 'full', label: 'Timer only (with flash)' },
						{ id: 'full-noflash', label: 'Timer only (no flash)' },
						{ id: 'free', label: 'Where the operator dragged it' },
						{ id: 'hidden', label: 'Hidden' },
					],
				},
			],
			callback: async (e) => run(e.actionId, e.options),
		},

		// ── Сообщение спикеру ──
		message_preset: {
			name: 'Speaker message: Show preset N',
			description: 'Preset texts are edited in CueDeck (right-click the preset button).',
			options: [{ id: 'preset', type: 'number', label: 'Preset №', default: 1, min: 1, max: 99, asInteger: true }],
			callback: async (e) => run(e.actionId, e.options),
		},
		message_text: {
			name: 'Speaker message: Show text',
			options: [
				{ id: 'text', type: 'textinput', label: 'Text', default: 'Questions from the audience', useVariables: true },
			],
			callback: async (e) => run(e.actionId, e.options),
		},
		message_clear: {
			name: 'Speaker message: Clear',
			options: [],
			callback: async (e) => run(e.actionId, e.options),
		},

		custom: {
			name: 'Custom command',
			description:
				'Any command from CueDeck → ⚙ Settings → External control → Command list, e.g. timer/set/20 or playlist/air/5.',
			options: [{ id: 'path', type: 'textinput', label: 'Command', default: 'timer/toggle', useVariables: true }],
			callback: async (e) => run(e.actionId, e.options),
		},
	}

	self.setActionDefinitions(actions)
}
