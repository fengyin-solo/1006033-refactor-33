import type { EntryRow } from './types'

/**
 * 机坪安全巡查的唯一业务判断来源。
 *
 * 巡查状态能不能提交整改、整改单号要不要填、复查日期怎么算、班组待办取哪些记录，
 * 以前在页面、动作层（local-service）、汇总（统计卡片/运营概览/保障班组待办）各抄了一份，
 * 口径已经打架。现在三处都只引用本文件，不得再各写判断。
 *
 * ── 口径裁决（两条旧规冲突时以此为准）──────────────────────────────
 * 1. 整改单号：「提交整改时单号必填」与「巡查中可暂不填」不是平级矛盾，而是两个阶段的规则。
 *    - 巡查中可暂不填：登记阶段豁免。整改单是巡查发现问题之后才开具的，巡查进行中客观上
 *      还没有单号，强制填写违背业务时序。
 *    - 提交整改时必填：提交即代表整改立项，整改单号是复查闭环、保障班组待办追踪的唯一凭证；
 *      空单号进入「待整改」会让问题无法闭环。
 *    合并为一条：执行「提交整改」动作时，整改单号必填且不得为空白；单号空白的记录只能停在
 *    「巡查中」，不得进入「待整改」。
 * 2. 复查日期：提交整改时由系统按下式统一回填，不接受人工另录：
 *      复查日期 = 巡查时间所在日 + REVIEW_DEADLINE_DAYS 个自然日
 *    以巡查时间（发现问题时点）为锚，而不是提交当天——整改时限从问题被发现起算。
 *    巡查时间缺失或无法解析为日期时，拒绝提交（宁可不流转，也不写进算不出复查日期的记录）。
 *
 * ── 历史记录处理结论 ─────────────────────────────────────────────
 * 按旧口径（空单号也放行）放过的历史记录：留档，不按新口径重算/回滚状态——当时的操作在
 * 当时口径下是合规事实，追溯否定会破坏留档。但空单号进入待整改会造成班组待办断链，所以只
 * 回填缺口字段，且回填一律按巡查时间推算（见 backfillHistory 的逐条注释）。回填只执行一次。
 */

export const APRON_KEY = 'apron'

export const APRON_STATUSES = ['待巡查', '巡查中', '待整改', '已复查'] as const
export const APRON_ACTIONS = ['开始巡查', '提交整改', '确认复查'] as const

/** 动作 → 目标状态：模块元数据（modules.ts）也从这里取，不再另抄一份。 */
export const APRON_ACTION_TARGETS: Record<string, string> = {
  开始巡查: '巡查中',
  提交整改: '待整改',
  确认复查: '已复查',
}

/** 整改时限：自巡查时间起 3 个自然日内完成复查。 */
export const REVIEW_DEADLINE_DAYS = 3

const STATUS_PENDING_INSPECTION = '待巡查'
const STATUS_INSPECTING = '巡查中'
const STATUS_PENDING_RECTIFICATION = '待整改'
const STATUS_REVIEWED = '已复查'

const FIELD_ORDER_NO = '整改单号'
const FIELD_INSPECT_TIME = '巡查时间'
const FIELD_REVIEW_DATE = '复查日期'
const FIELD_INSPECT_NO = '巡查编号'

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 解析 YYYY-MM-DD（允许后面带时分秒，取前 10 位）；用 UTC 拼装，避免时区把日期拨前拨后。 */
export function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

function formatCalendarDate(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/** 巡查时间 + N 个自然日；入参不可解析时返回 null。 */
export function reviewDateFromInspectTime(inspectTime: string, days: number = REVIEW_DEADLINE_DAYS): string | null {
  const parsed = parseCalendarDate(inspectTime)
  if (!parsed) {
    return null
  }
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
  return formatCalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** 一条记录按统一公式算出的复查日期。 */
export function plannedReviewDate(row: EntryRow): string | null {
  return reviewDateFromInspectTime(fieldText(row, FIELD_INSPECT_TIME))
}

/** 存储层 pending 派生标志：未走到终态「已复查」都算未闭环。 */
export function isPendingRow(row: EntryRow): boolean {
  return String(row.status) !== STATUS_REVIEWED
}

/**
 * 保障班组待办清单、机坪页面「待整改问题」统计、运营概览共用的同一选择器：
 * 只有「待整改」是班组需要跟进的待整改问题，任何地方都不得再各算各的。
 */
export function pendingRectifications(rows: EntryRow[]): EntryRow[] {
  return rows.filter((row) => String(row.status) === STATUS_PENDING_RECTIFICATION)
}

/** 页面按行渲染可执行动作：只返回当前状态允许的那一个，终态返回空。 */
export function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case STATUS_PENDING_INSPECTION:
      return ['开始巡查']
    case STATUS_INSPECTING:
      return ['提交整改']
    case STATUS_PENDING_RECTIFICATION:
      return ['确认复查']
    default:
      return []
  }
}

export type ApronActionPlan = {
  ok: boolean
  message: string
  /** 校验通过后要写回该记录的字段片段（动作层负责落库，本文件不碰存储）。 */
  patch?: Partial<EntryRow>
}

/**
 * 动作层调用的统一流转判断：能不能动、为什么不能动、能动时写什么，全在这里定。
 * 注意：校验不通过时不返回 patch，调用方不得写库——重复提交因此只会被拒绝，不会二次推进。
 */
export function planAction(row: EntryRow, action: string): ApronActionPlan {
  const current = String(row.status)
  switch (action) {
    case '开始巡查': {
      if (current !== STATUS_PENDING_INSPECTION) {
        return { ok: false, message: `巡查记录当前为「${current}」，只有「待巡查」可以开始巡查` }
      }
      return {
        ok: true,
        message: '巡查记录已开始巡查，当前状态「巡查中」',
        patch: { status: STATUS_INSPECTING, pending: true },
      }
    }
    case '提交整改': {
      if (current !== STATUS_INSPECTING) {
        // 已提交过再点：明确告知且不动数据，保证同一条记录重复提交只推进一次。
        if (current === STATUS_PENDING_RECTIFICATION) {
          return { ok: false, message: '巡查记录已提交整改，当前为「待整改」，请勿重复提交' }
        }
        return { ok: false, message: `巡查记录当前为「${current}」，只有「巡查中」可以提交整改` }
      }
      if (fieldText(row, FIELD_ORDER_NO) === '') {
        return { ok: false, message: '提交整改时必须填写整改单号（巡查中可暂不填，提交时必填）' }
      }
      const reviewDate = plannedReviewDate(row)
      if (!reviewDate) {
        return { ok: false, message: '巡查时间缺失或不是 YYYY-MM-DD 日期，无法计算复查日期，不能提交整改' }
      }
      return {
        ok: true,
        message: `巡查记录已提交整改，当前状态「待整改」，复查日期「${reviewDate}」`,
        patch: { status: STATUS_PENDING_RECTIFICATION, pending: true, [FIELD_REVIEW_DATE]: reviewDate },
      }
    }
    case '确认复查': {
      if (current !== STATUS_PENDING_RECTIFICATION) {
        return { ok: false, message: `巡查记录当前为「${current}」，只有「待整改」可以确认复查` }
      }
      return {
        ok: true,
        message: '巡查记录已确认复查，当前状态「已复查」',
        patch: { status: STATUS_REVIEWED, pending: false },
      }
    }
    default:
      return { ok: false, message: `巡查记录没有登记「${action}」这个动作` }
  }
}

export type ApronSummary = {
  todayInspectionCount: number
  inspectingCount: number
  pendingRectificationCount: number
}

function localDateText(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 页面统计卡片与概览共用同一份汇总口径。 */
export function summarize(rows: EntryRow[], today: Date = new Date()): ApronSummary {
  const todayText = localDateText(today)
  return {
    todayInspectionCount: rows.filter(
      (row) => fieldText(row, FIELD_INSPECT_TIME).slice(0, 10) === todayText,
    ).length,
    inspectingCount: rows.filter((row) => String(row.status) === STATUS_INSPECTING).length,
    pendingRectificationCount: pendingRectifications(rows).length,
  }
}

/**
 * 历史数据一次性回填（留档不重算，只补缺口，细节见文件头注释）：
 * - 「待巡查」「巡查中」：单号/复查日期一律不动——继续享受「巡查中可暂不填」。
 * - 「待整改」「已复查」（即旧口径下已经过了提交关的记录）：
 *   · 整改单号空白 → 用巡查编号回填；巡查编号也缺失时用 APRO-<id> 补，绝不留空单号。
 *   · 复查日期空白或不可解析 → 按「巡查时间 + 3 个自然日」补；巡查时间也不可解析则不臆造，原样保留。
 *   · 已有值一律不覆盖，状态与其他字段一律不改。
 * - pending 是由状态派生的技术标志（非业务留档字段），所有记录按统一口径重算，
 *   保证概览、班组待办、页面统计读到的结果一致。
 */
export function backfillHistory(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const fixed: EntryRow = { ...row, pending: isPendingRow(row) }
    const status = String(row.status)
    if (status !== STATUS_PENDING_RECTIFICATION && status !== STATUS_REVIEWED) {
      return fixed
    }
    if (fieldText(row, FIELD_ORDER_NO) === '') {
      const inspectNo = fieldText(row, FIELD_INSPECT_NO)
      fixed[FIELD_ORDER_NO] = inspectNo !== '' ? inspectNo : `APRO-${String(row.id).padStart(4, '0')}`
    }
    const reviewText = fieldText(row, FIELD_REVIEW_DATE)
    if (reviewText === '' || parseCalendarDate(reviewText) === null) {
      const reviewDate = plannedReviewDate(row)
      if (reviewDate) {
        fixed[FIELD_REVIEW_DATE] = reviewDate
      }
    }
    return fixed
  })
}
