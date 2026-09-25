import type {
	CompanionButtonStyleProps,
	CompanionPresetDefinitions,
	CompanionPresetGroup,
	CompanionPresetSection,
	CompanionSimplePresetDefinition,
} from '@companion-module/base'
import type { Lang } from './config.js'
import { C } from './feedbacks.js'
import type { ModuleSchema } from './main.js'
import type ModuleInstance from './main.js'

/**
 * «Книга» кнопок: вкладка Presets в Companion, разделы по тем же группам,
 * что и готовая страница CueDeck (companion/build.ts). Оператор перетаскивает
 * кнопку на свою страницу — действие, живой текст и цвета уже настроены.
 */

type Preset = CompanionSimplePresetDefinition<ModuleSchema>
type Action = Preset['steps'][number]['down'][number]
type Feedback = Preset['feedbacks'][number]

const T = {
	ru: {
		sTimer: 'Таймер',
		sProgram: 'Эфир',
		sVideo: 'Ролик в эфире',
		sPlaylist: 'Плейлист',
		sMessage: 'Сообщение спикеру',
		sPreview: 'Превью',
		gTimerMain: 'Основное',
		gTimerSet: 'Задать время',
		gTimerMode: 'Режим и вид',
		gSpeakersPreview: 'Спикер N → превью',
		gSpeakersAir: 'Спикер N → сразу в эфир',
		gPlaylistStep: 'Следующий / предыдущий',
		timer: 'ТАЙМЕР',
		offline: 'нет связи',
		start: 'СТАРТ',
		pause: 'ПАУЗА',
		restart: '↺ СТАРТ\nзаново',
		reset: 'ТАЙМЕР\nсброс',
		min: 'мин',
		preset: 'ПРЕСЕТ',
		full: 'ТОЛЬКО\nТАЙМЕР ⛶',
		countdown: 'ОБРАТНЫЙ\nОТСЧЁТ',
		stopwatch: 'СЕКУНДО-\nМЕР',
		clock: 'ЧАСЫ',
		next: 'ДАЛЕЕ ▶',
		prev: '◀\nНАЗАД',
		take: 'ЭФИР ▶',
		blackout: 'ЗАСТАВКА',
		onAir: 'В ЭФИРЕ',
		video: 'РОЛИК ▶⏸',
		videoRestart: 'РОЛИК\nс начала',
		videoStop: 'РОЛИК\nстоп',
		videoBack: 'РОЛИК\n−10 с',
		videoFwd: 'РОЛИК\n+10 с',
		soundOn: 'ЗВУК\nвкл',
		soundOff: 'ЗВУК\nвыкл',
		loop: 'ЦИКЛ',
		nextSpeaker: 'СЛЕД. →',
		prevSpeaker: '← ПРЕД.\nпревью',
		speaker: 'СПИКЕР',
		toAir: '→ ЭФИР',
		message: 'СПИКЕРУ',
		clearMsg: 'УБРАТЬ\nтекст',
		pvNext: 'ПРЕВЬЮ\nслайд ▶',
		pvPrev: 'ПРЕВЬЮ\n◀ слайд',
		pvVideo: 'ПРЕВЬЮ\nролик ▶⏸',
		pvClear: 'ПРЕВЬЮ\nочистить',
	},
	en: {
		sTimer: 'Timer',
		sProgram: 'Program',
		sVideo: 'Video on air',
		sPlaylist: 'Playlist',
		sMessage: 'Speaker message',
		sPreview: 'Preview',
		gTimerMain: 'Main',
		gTimerSet: 'Set time',
		gTimerMode: 'Mode and view',
		gSpeakersPreview: 'Speaker N → preview',
		gSpeakersAir: 'Speaker N → straight on air',
		gPlaylistStep: 'Next / previous',
		timer: 'TIMER',
		offline: 'offline',
		start: 'START',
		pause: 'PAUSE',
		restart: '↺ RESTART',
		reset: 'TIMER\nreset',
		min: 'min',
		preset: 'PRESET',
		full: 'TIMER\nONLY ⛶',
		countdown: 'COUNT\nDOWN',
		stopwatch: 'STOP\nWATCH',
		clock: 'CLOCK',
		next: 'NEXT ▶',
		prev: '◀\nBACK',
		take: 'TAKE ▶',
		blackout: 'BLACKOUT',
		onAir: 'ON AIR',
		video: 'VIDEO ▶⏸',
		videoRestart: 'VIDEO\nfrom start',
		videoStop: 'VIDEO\nstop',
		videoBack: 'VIDEO\n−10 s',
		videoFwd: 'VIDEO\n+10 s',
		soundOn: 'SOUND\non',
		soundOff: 'SOUND\noff',
		loop: 'LOOP',
		nextSpeaker: 'NEXT →',
		prevSpeaker: '← PREV\npreview',
		speaker: 'SPEAKER',
		toAir: '→ AIR',
		message: 'MESSAGE',
		clearMsg: 'CLEAR\nmessage',
		pvNext: 'PREVIEW\nslide ▶',
		pvPrev: 'PREVIEW\n◀ slide',
		pvVideo: 'PREVIEW\nvideo ▶⏸',
		pvClear: 'PREVIEW\nclear',
	},
} as const satisfies Record<Lang, Record<string, string>>

/**
 * Кегль по самой длинной строке. «auto» не годится: Companion выбирает самый
 * крупный кегль и рвёт слово посередине («ТАЙМЕ/Р»). Ступени подобраны на
 * живом Companion 5.0.6: 24 вмещает 3 заглавные кириллицей, 18 — 5, 14 — 7.
 * Строка с переменной (имя спикера, текст сообщения) — 14, пусть переносится.
 */
function fit(text: string): CompanionButtonStyleProps['size'] {
	const lines = text.split('\n')
	if (lines.some((l) => l.includes('$('))) return '14'
	const longest = Math.max(...lines.map((l) => [...l].length))
	return longest <= 3 ? '24' : longest <= 5 ? '18' : longest <= 7 ? '14' : 12
}

const SPEAKERS = 8
const MESSAGE_PRESETS = 4
const TIMER_PRESETS = 4
const QUICK_MINUTES = [5, 10, 15, 20]

export function UpdatePresets(self: ModuleInstance): void {
	const t = T[self.config.lang] ?? T.ru
	const v = (name: string): string => `$(${self.label}:${name})`

	const presets: CompanionPresetDefinitions<ModuleSchema> = {}

	const add = (
		id: string,
		name: string,
		text: string,
		actions: Action[],
		feedbacks: Feedback[] = [],
		style: Partial<CompanionButtonStyleProps> = {},
		offlineStyle: Partial<CompanionButtonStyleProps> = { color: C.muted },
	): string => {
		presets[id] = {
			type: 'simple',
			name,
			style: { text, size: fit(text), color: C.white, bgcolor: C.black, show_topbar: false, ...style },
			steps: actions.length ? [{ down: actions, up: [] }] : [],
			feedbacks: [
				...feedbacks,
				// Последним: без связи кнопка гаснет, а не показывает замершее значение.
				{ feedbackId: 'offline', options: {}, style: offlineStyle },
			],
		}
		return id
	}
	const a = (actionId: Action['actionId'], options: Record<string, unknown> = {}): Action =>
		({ actionId, options }) as Action

	// ── Таймер ──
	const timerMain = [
		add(
			'timer_main',
			`${t.timer}: start / pause`,
			// Только цифры и крупно: подпись «ТАЙМЕР» съела бы кегль у времени.
			v('timer'),
			[a('timer', { cmd: 'toggle' })],
			[
				{ feedbackId: 'timer_color', options: {} },
				{ feedbackId: 'timer_over', options: { blink: true }, style: { bgcolor: C.blinkRed, color: C.white } },
			],
			{ size: '18' },
			{ text: t.offline, size: '14', color: C.muted },
		),
		add(
			'timer_start',
			'Start',
			t.start,
			[a('timer', { cmd: 'start' })],
			[{ feedbackId: 'timer_running', options: {}, style: { bgcolor: C.greenBg } }],
		),
		add('timer_pause', 'Pause', t.pause, [a('timer', { cmd: 'pause' })]),
		add('timer_restart', 'Reset and start', t.restart, [a('timer', { cmd: 'restart' })]),
		add('timer_reset', 'Reset', t.reset, [a('timer', { cmd: 'reset' })]),
		add('timer_add_1', '+1 min', `+1\n${t.min}`, [a('timer_adjust', { direction: 'add', amount: '1' })]),
		add('timer_sub_1', '−1 min', `−1\n${t.min}`, [a('timer_adjust', { direction: 'sub', amount: '1' })]),
		add('timer_add_5', '+5 min', `+5\n${t.min}`, [a('timer_adjust', { direction: 'add', amount: '5' })]),
		add('timer_sub_5', '−5 min', `−5\n${t.min}`, [a('timer_adjust', { direction: 'sub', amount: '5' })]),
	]

	const timerSet = [
		...QUICK_MINUTES.map((m) =>
			add(`timer_set_${m}`, `Set ${m} min`, `${t.timer}\n${m} ${t.min}`, [a('timer_set', { duration: String(m) })]),
		),
		...Array.from({ length: TIMER_PRESETS }, (_, i) =>
			add(
				`timer_preset_${i + 1}`,
				`Preset ${i + 1} (minutes from CueDeck)`,
				`${t.preset} ${i + 1}\n${v(`timer_preset_${i + 1}`)} ${t.min}`,
				[a('timer_preset', { preset: i + 1 })],
			),
		),
	]

	const timerMode = [
		add(
			'timer_full',
			'Timer only on the monitor',
			t.full,
			[a('timer', { cmd: 'fullscreen' })],
			[{ feedbackId: 'timer_fullscreen', options: {}, style: { bgcolor: C.amberBg } }],
		),
		add('timer_mode_countdown', 'Mode: countdown', t.countdown, [a('timer_mode', { mode: 'countdown' })]),
		add('timer_mode_stopwatch', 'Mode: stopwatch', t.stopwatch, [a('timer_mode', { mode: 'stopwatch' })]),
		add('timer_mode_clock', 'Mode: clock', t.clock, [a('timer_mode', { mode: 'clock' })]),
	]

	// ── Эфир ──
	const program = [
		add(
			'program_next',
			'Next — slide counter below',
			`${t.next}\n${v('slide')}`,
			[a('program_next')],
			[{ feedbackId: 'last_slide', options: {}, style: { bgcolor: C.amberBg } }],
		),
		add('program_prev', 'Back', t.prev, [a('program_prev')]),
		add(
			'take',
			'TAKE — what is in preview below',
			`${t.take}\n${v('preview')}`,
			[a('take')],
			[{ feedbackId: 'preview_loaded', options: {}, style: { bgcolor: C.redBg } }],
		),
		add(
			'blackout',
			'Blackout',
			t.blackout,
			[a('blackout', { mode: 'toggle' })],
			[{ feedbackId: 'blackout', options: {}, style: { bgcolor: C.redBg } }],
		),
		add('on_air', 'On air (display only)', `${t.onAir}\n${v('program')}`, [], [], { color: C.red }),
	]

	// ── Ролик ──
	const video = [
		add(
			'video_toggle',
			'Play / pause — time left below',
			`${t.video}\n${v('video_remaining')}`,
			[a('video', { cmd: 'toggle' })],
			[{ feedbackId: 'video_playing', options: {}, style: { bgcolor: C.greenBg } }],
		),
		add('video_restart', 'From the start', t.videoRestart, [a('video', { cmd: 'restart' })]),
		add('video_stop', 'Stop', t.videoStop, [a('video', { cmd: 'stop' })]),
		add('video_back', '−10 s', t.videoBack, [a('video_seek', { direction: 'back', seconds: 10 })]),
		add('video_fwd', '+10 s', t.videoFwd, [a('video_seek', { direction: 'forward', seconds: 10 })]),
		add(
			'video_mute',
			'Program audio on / off',
			t.soundOn,
			[a('video_mute', { mode: 'toggle' })],
			[{ feedbackId: 'muted', options: {}, style: { bgcolor: C.redBg, text: t.soundOff } }],
		),
		add(
			'video_loop',
			'Loop',
			t.loop,
			[a('video_loop', { mode: 'toggle' })],
			[{ feedbackId: 'video_loop', options: {}, style: { bgcolor: C.amberBg } }],
		),
	]

	// ── Плейлист ──
	const tally = (i: number): Feedback[] => [
		{ feedbackId: 'entry_state', options: { entry: i, state: 'preview' }, style: { bgcolor: C.greenBg } },
		{ feedbackId: 'entry_state', options: { entry: i, state: 'program' }, style: { bgcolor: C.redBg } },
	]
	const playlistStep = [
		add('playlist_next', 'Next speaker into preview — who below', `${t.nextSpeaker}\n${v('next')}`, [
			a('playlist_step', { direction: 'next' }),
		]),
		add('playlist_prev', 'Previous speaker into preview', t.prevSpeaker, [a('playlist_step', { direction: 'prev' })]),
	]
	const speakersPreview = Array.from({ length: SPEAKERS }, (_, k) => {
		const i = k + 1
		return add(
			`speaker_${i}`,
			`Speaker ${i} into preview (red — on air, green — in preview)`,
			`${t.speaker} ${i}\n${v(`speaker_${i}`)}`,
			[a('playlist_entry', { entry: i, target: 'preview' })],
			tally(i),
		)
	})
	const speakersAir = Array.from({ length: SPEAKERS }, (_, k) => {
		const i = k + 1
		return add(
			`speaker_${i}_air`,
			`Speaker ${i} straight on air`,
			`${i} ${t.toAir}\n${v(`speaker_${i}`)}`,
			[a('playlist_entry', { entry: i, target: 'air' })],
			tally(i),
		)
	})

	// ── Сообщение ──
	const messages = [
		...Array.from({ length: MESSAGE_PRESETS }, (_, k) =>
			add(
				`message_${k + 1}`,
				`Message preset ${k + 1} (text from CueDeck)`,
				`${t.message} ${k + 1}\n${v(`message_preset_${k + 1}`)}`,
				[a('message_preset', { preset: k + 1 })],
			),
		),
		add(
			'message_clear',
			'Clear message',
			t.clearMsg,
			[a('message_clear')],
			[{ feedbackId: 'message_shown', options: {}, style: { bgcolor: C.amberBg } }],
		),
	]

	// ── Превью ──
	const preview = [
		add('preview_next', 'Preview: next slide', t.pvNext, [a('preview', { cmd: 'next' })]),
		add('preview_prev', 'Preview: previous slide', t.pvPrev, [a('preview', { cmd: 'prev' })]),
		add('preview_video', 'Preview: video play / pause', t.pvVideo, [a('preview', { cmd: 'video_toggle' })]),
		add('preview_clear', 'Preview: clear', t.pvClear, [a('preview', { cmd: 'clear' })]),
	]

	const group = (id: string, name: string, list: string[]): CompanionPresetGroup<ModuleSchema> => ({
		id,
		type: 'simple',
		name,
		presets: list,
	})

	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'timer',
			name: t.sTimer,
			definitions: [
				group('timer_main', t.gTimerMain, timerMain),
				group('timer_set', t.gTimerSet, timerSet),
				group('timer_mode', t.gTimerMode, timerMode),
			],
		},
		{ id: 'program', name: t.sProgram, definitions: program },
		{ id: 'video', name: t.sVideo, definitions: video },
		{
			id: 'playlist',
			name: t.sPlaylist,
			definitions: [
				group('playlist_step', t.gPlaylistStep, playlistStep),
				group('speakers_preview', t.gSpeakersPreview, speakersPreview),
				group('speakers_air', t.gSpeakersAir, speakersAir),
			],
		},
		{ id: 'message', name: t.sMessage, definitions: messages },
		{ id: 'preview', name: t.sPreview, definitions: preview },
	]

	self.setPresetDefinitions(structure, presets)
}
