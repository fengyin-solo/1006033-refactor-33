import { APRON_MODULE_KEY, backfillLegacyInspection } from './apron-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 历史口径迁移版本：v2 起对机坪巡查记录按统一规则回填复查日期并归一 pending。
const VERSION_KEY = 'airport-ground-ops:version'
const CURRENT_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 旧版缓存的一次性回填：机坪巡查历史记录按巡查时间重算复查日期，详见 apron-rules 口径裁决。 */
function migrateLegacy(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (data[APRON_MODULE_KEY]) {
    data[APRON_MODULE_KEY] = data[APRON_MODULE_KEY].map(backfillLegacyInspection)
  }
  return data
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    window.localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 已是当前口径的缓存不重复回填，迁移严格只跑一次；回填函数本身也幂等，重复跑结果不变。
    if (window.localStorage.getItem(VERSION_KEY) !== String(CURRENT_VERSION)) {
      migrateLegacy(parsed)
    }
    persist({ ...fallback, ...parsed })
    return { ...fallback, ...parsed }
  } catch {
    persist(fallback)
    return fallback
  }
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
