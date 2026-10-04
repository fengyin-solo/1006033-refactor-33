import { backfillHistory, APRON_KEY } from './apron-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 历史回填版本：口径收拢（见 data/apron-rules.ts）后对已留档的机坪巡查记录只补一次缺口字段。
const MIGRATION_KEY = 'airport-ground-ops:migration-version'
const MIGRATION_VERSION = 1

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let data: Record<string, EntryRow[]>
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    data = fallback
  } else {
    try {
      const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
      data = { ...fallback, ...parsed }
    } catch {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
  }
  return applyMigrations(data)
}

/**
 * 一次性历史数据回填。回填口径在 data/apron-rules.ts 的 backfillHistory 里裁决：
 * 历史记录留档、不按新口径重算状态，只按巡查时间补空单号/空复查日期。
 */
function applyMigrations(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return data
  }
  const applied = Number(window.localStorage.getItem(MIGRATION_KEY) ?? '0')
  if (applied >= MIGRATION_VERSION) {
    return data
  }
  if (Array.isArray(data[APRON_KEY])) {
    data = { ...data, [APRON_KEY]: backfillHistory(data[APRON_KEY]) }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
  window.localStorage.setItem(MIGRATION_KEY, String(MIGRATION_VERSION))
  return data
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
