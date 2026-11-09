// 工单状态（beads status）的唯一映射：看板列、详情页、筛选用同一套。
// 状态不再从 run.json 派生；AI 进度只是工单上的一枚徽章（见 workflow.mjs）。
//
//   新建 open ──AI 接单/人工开始──> 开发中 in_progress
//     开发中 ──人工验收──> 策划验收 plan_review ──> 测试验收 test_review
//       ──> 已完成 closed ──> 已归档 archived
//
// plan_review / test_review / archived 是 bd 的 status.custom，由 ensureWorkflowStatuses()
// 写进项目自己的 beads 配置；open / in_progress / closed 是 bd 内置状态。
export const STAGES = [
  { id: 'new', label: '新建', status: 'open', tone: 'idle', empty: '没有新建的单。' },
  { id: 'developing', label: '开发中', status: 'in_progress', tone: 'live', empty: '没有在开发的单。' },
  { id: 'plan_review', label: '策划验收', status: 'plan_review', tone: 'review', empty: '没有等待策划验收的单。' },
  { id: 'test_review', label: '测试验收', status: 'test_review', tone: 'review', empty: '没有等待测试验收的单。' },
  { id: 'done', label: '已完成', status: 'closed', tone: 'ok', empty: '还没有完成的单。' },
  { id: 'archived', label: '已归档', status: 'archived', tone: 'muted', empty: '没有归档的单。' },
];

/** 看板列只要这三个字段；tone/status 是服务端自己的事。 */
export const STAGE_COLUMNS = STAGES.map(({ id, label, empty }) => ({ id, label, empty }));
export const STAGE_IDS = STAGES.map((s) => s.id);
/** 允许写进 beads 的状态值（旧 review 也认，方便旧单被人工改回来）。 */
export const STATUS_VALUES = [...STAGES.map((s) => s.status), 'review'];
/** 要写进项目 beads 配置的自定义状态；分类让 bd 的 ready/list 知道它们是活跃/终结状态。 */
export const CUSTOM_STATUSES = ['plan_review:active', 'test_review:active', 'archived:frozen'];

const BY_STATUS = new Map(STAGES.map((s) => [s.status, s]));
const BY_ID = new Map(STAGES.map((s) => [s.id, s]));
// 旧数据：review 是上一版 AI 审查阶段，归入开发中；blocked/deferred 不单独占用一列。
const LEGACY = { review: 'developing', blocked: 'developing', deferred: 'new' };

/** 工单的规范化状态；未知状态回落到「新建」，绝不把卡片弄丢。 */
export function stageOf(issueOrStatus) {
  if (issueOrStatus && typeof issueOrStatus === 'object' && issueOrStatus.stage?.id && BY_ID.has(issueOrStatus.stage.id)) {
    return issueOrStatus.stage;
  }
  const status = typeof issueOrStatus === 'string' ? issueOrStatus : issueOrStatus?.status;
  return BY_STATUS.get(status) ?? BY_ID.get(LEGACY[status]) ?? STAGES[0];
}

export function stageById(id) {
  return BY_ID.get(id) ?? null;
}

/** bd status → 状态定义；不认识的返回 null（用于校验写入）。 */
export function stageForStatus(status) {
  return BY_STATUS.get(status) ?? BY_ID.get(LEGACY[status]) ?? null;
}

export function isKnownStatus(status) {
  return STATUS_VALUES.includes(status) && Boolean(stageForStatus(status));
}

/** 评论里用：优先写人看得懂的中文名。 */
export function statusLabel(status) {
  return stageForStatus(status)?.label ?? String(status ?? '');
}
