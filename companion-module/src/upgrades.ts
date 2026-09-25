import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

/**
 * Скрипты обновления конфигов кнопок между версиями модуля. Добавленный
 * скрипт удалять нельзя — Companion помнит, какие уже применены.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = []
