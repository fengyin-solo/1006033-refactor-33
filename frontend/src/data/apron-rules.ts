import type { EntryRow } from './types'

/**
 * 机坪安全巡查业务规则（唯一出处）
 *
 * 收拢前，「巡查状态能不能提交整改 / 整改单号要不要填 / 复查日期怎么算」在页面、动作层、
 * 汇总各写了一份，三份口径已经打架（一处要求整改单号必填，另一处放行空单号）。本文件是这段
 * 判断的唯一出处，机坪巡查页面、动作层流转、运营概览汇总、保障班组待办一律引用这里，不再各算各的。
 *
 * 口径裁决（2026-10-04）：
 * 1. 整改单号冲突，以「提交整改时必填」为准。「巡查中可暂不填」针对的是巡查进行中的记录——
 *    待巡查/巡查中阶段整改单号尚未生成，允许为空，二者并不矛盾；冲突只发生在「提交整改」这一步，
 *    此时单号为空一律拒绝。依据：整改单号是巡查发现进入整改闭环、派到保障班组待办、复查核销的
 *    唯一关联键，空单号会让待办挂不上、复查对不上，闭环断裂。
 * 2. 复查日期：提交整改时按「巡查时间 + 7 个自然日」生成（限期 7 天整改、到期复查），只认
 *    YYYY-MM-DD 的巡查时间。
 * 3. 历史记录按当时口径留档：不回滚状态、不判异常；但对仍是「待整改」的历史记录，以其巡查时间
 *    为基准一次性回填复查日期（见 backfillLegacyInspection）；历史空单号不补录，在保障班组待办里
 *    标注「单号待补」，不阻断后续复查。已复查记录的复查日期是归档事实，不动。
 * 4. 同一条记录重复「提交整改」只推进一次：已是「待整改」由动作层同态守卫直接拒绝，复查日期
 *    不重算、状态不重复推进。
 */

export const APRON_MODULE_KEY = 'apron'
export const SUBMIT_RECTIFICATION_ACTION = '提交整改'

const STATUS_PENDING = '待巡查'
const STATUS_INSPECTING = '巡查中'
const STATUS_RECTIFYING = '待整改'
const STATUS_REVIEWED = '已复查'

const FIELD_ISSUE_COUNT = '发现问题数'
const FIELD_RECTIFY_ORDER = '整改单号'
const FIELD_INSPECT_TIME = '巡查时间'
const FIELD_REVIEW_DATE = '复查日期'

/** 整改期限：巡查时间之后 7 个自然日复查。 */
const RECTIFICATION_DEADLINE_DAYS = 7

function asText(value: unknown): string {
  return String(value ?? '').trim()
}

/** 状态前提：只有「巡查中」的记录能提交整改（待巡查须先开始巡查，待整改/已复查不能再提交）。 */
export function canSubmitRectification(row: EntryRow): boolean {
  return asText(row.status) === STATUS_INSPECTING
}

/** 整改单号是否缺失（巡查阶段允许为空，提交整改时用 checkSubmitRectification 拦截）。 */
export function isRectificationOrderMissing(row: EntryRow): boolean {
  return asText(row[FIELD_RECTIFY_ORDER]) === ''
}

/** 待整改问题：以记录状态为准，页面统计、汇总、班组待办共用这一个口径。 */
export function isPendingRectification(row: EntryRow): boolean {
  return asText(row.status) === STATUS_RECTIFYING
}

function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  // 挡掉 2026-13-40 这类能被 Date 归一、但实际不存在的伪日期
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

function formatDay(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 复查日期：巡查时间 + 7 个自然日；巡查时间缺失或不是 YYYY-MM-DD 时算不出来（返回 null）。 */
export function expectedReviewDate(row: EntryRow): string | null {
  const inspectDate = parseDay(asText(row[FIELD_INSPECT_TIME]))
  if (!inspectDate) {
    return null
  }
  const reviewDate = new Date(inspectDate)
  reviewDate.setDate(reviewDate.getDate() + RECTIFICATION_DEADLINE_DAYS)
  return formatDay(reviewDate)
}

export type RectificationSubmission =
  | { ok: true; reviewDate: string }
  | { ok: false; message: string }

/**
 * 动作层「提交整改」的唯一门禁：巡查中 + 整改单号必填 + 巡查时间可算出复查日期。
 * 通过时同时给出应写入的复查日期，调用方不要再自己另算一遍。
 */
export function checkSubmitRectification(row: EntryRow): RectificationSubmission {
  if (!canSubmitRectification(row)) {
    return {
      ok: false,
      message: `巡查记录当前为「${asText(row.status) || '空状态'}」，需处于「${STATUS_INSPECTING}」才能提交整改`,
    }
  }
  if (isRectificationOrderMissing(row)) {
    return { ok: false, message: '提交整改前必须填写整改单号，「巡查中」阶段才可暂不填' }
  }
  const reviewDate = expectedReviewDate(row)
  if (!reviewDate) {
    return { ok: false, message: '巡查时间缺失或不是 YYYY-MM-DD 格式，无法计算复查日期' }
  }
  return { ok: true, reviewDate }
}

/** 待办展示口径：保障班组读到的待整改问题由这一个投影生成，不允许页面再各算一份。 */
export type RectificationTodo = {
  id: number
  inspectCode: string
  area: string
  issueCount: number
  orderNo: string
  orderMissing: boolean
  inspectTime: string
  reviewDate: string
}

export function rectificationTodos(rows: EntryRow[]): RectificationTodo[] {
  return rows.filter(isPendingRectification).map((row) => {
    const parsed = Number(asText(row[FIELD_ISSUE_COUNT]))
    return {
      id: Number(row.id),
      inspectCode: asText(row['巡查编号']),
      area: asText(row['巡查区域']),
      // 发现问题数填的不是正整数时，一条待整改记录至少按 1 个问题计
      issueCount: Number.isInteger(parsed) && parsed > 0 ? parsed : 1,
      orderNo: asText(row[FIELD_RECTIFY_ORDER]),
      orderMissing: isRectificationOrderMissing(row),
      inspectTime: asText(row[FIELD_INSPECT_TIME]),
      reviewDate: asText(row[FIELD_REVIEW_DATE]),
    }
  })
}

/** 「待整改问题」统计：同一条待整改记录按其发现问题数求和，与班组待办用同一批记录。 */
export function rectificationIssueCount(rows: EntryRow[]): number {
  return rectificationTodos(rows).reduce((sum, todo) => sum + todo.issueCount, 0)
}

/** 机坪模块的待处理口径：除「已复查」外都算待处理，与状态流转的终态定义保持一致。 */
export function apronPendingCount(rows: EntryRow[]): number {
  return rows.filter((row) => asText(row.status) !== STATUS_REVIEWED).length
}

/**
 * 历史数据一次性回填（幂等）：
 * - pending 标志按「已复查才收尾」归一，修正历史上与流转引擎不一致的写值；
 * - 仍是「待整改」的记录，按巡查时间 + 7 天重算复查日期（巡查时间不可算则保留原值）；
 * - 已复查记录的复查日期是归档事实，不动；历史空单号保留、不补录。
 */
export function backfillLegacyInspection(row: EntryRow): EntryRow {
  const status = asText(row.status)
  const next: EntryRow = { ...row, pending: status !== STATUS_REVIEWED }
  if (status === STATUS_RECTIFYING) {
    const reviewDate = expectedReviewDate(next)
    if (reviewDate) {
      next[FIELD_REVIEW_DATE] = reviewDate
    }
  }
  return next
}
