/**
 * 离线协作核心：修订号、离线批次队列、字段级冲突检测、幂等重试、重复合并指向主记录。
 *
 * 设计要点：
 * - 每条修改都带修订号（revision），离线批次按原记录（issueId）排队。
 * - 同步时按字段比对：服务端值 === 基线值才覆盖；否则保留两版待审核，不整条覆盖。
 * - 每个操作有稳定 opId（客户端生成），重试时已写入的修改与时间线不会重复追加。
 * - 合并重复问题后，主问题、操作时间线、旧链接都指向同一个主记录。
 */

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type NetworkStatus = 'online' | 'offline';

/** 字段级冲突：同一字段被不同人改成不同值，保留两版待审核。 */
export interface FieldConflict {
  id: string;
  issueId: string;
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  serverValue: unknown;
  localValue: unknown;
  opId: string;
  author: string;
  at: string;
  status: 'pending' | 'resolved';
  resolution?: 'server' | 'local';
}

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  /** 服务端修订号，每次成功写入 +1。 */
  revision: number;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
  /** 幂等键：重试时凭它判断是否已写入，避免重复追加时间线。 */
  opId?: string;
  author?: string;
  revision?: number;
}

export interface WorkbenchState {
  issues: AuditIssue[];
  events: AuditEvent[];
  conflicts: FieldConflict[];
}

/** 单字段修改：从基线值 from 改为 to。 */
export interface FieldChange {
  field: string;
  fieldLabel: string;
  from: unknown;
  to: unknown;
}

export interface ChangeOperation {
  opId: string;
  opType: 'create' | 'edit';
  /** 原记录 id：离线批次按它排队。 */
  issueId: string;
  baseRevision: number;
  changes: FieldChange[];
  /** create 操作的完整问题数据。 */
  issueData?: AuditIssue;
  author: string;
  at: string;
  message: string;
  status: 'pending' | 'applied' | 'conflict' | 'failed';
}

export interface OfflineBatch {
  batchId: string;
  createdAt: string;
  ops: ChangeOperation[];
  status: 'queued' | 'syncing' | 'applied' | 'failed';
  error?: string;
}

export interface OutboxState {
  batches: OfflineBatch[];
}

const SERVER_KEY = 'a11y-audit-server-v1';
const LOCAL_KEY = 'a11y-audit-local-v1';
const OUTBOX_KEY = 'a11y-audit-outbox-v1';

export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '影响人群',
  severity: '严重程度',
  status: '状态',
  fixNote: '修复记录',
  retestNote: '复测记录'
};

export function seedState(): WorkbenchState {
  const now = Date.now();
  return {
    issues: [
      { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', revision: 1, updatedAt: new Date(now - 3600_000).toISOString() },
      { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', revision: 1, updatedAt: new Date(now - 7200_000).toISOString() }
    ],
    events: [
      { id: 'e-1', at: new Date(now - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中', author: '审核员', revision: 1 },
      { id: 'e-2', at: new Date(now - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复', author: '开发人员', revision: 1 }
    ],
    conflicts: []
  };
}

export function emptyOutbox(): OutboxState {
  return { batches: [] };
}

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用时忽略，内存态仍可继续 */
  }
}

export function loadServer(): WorkbenchState {
  return loadJSON<WorkbenchState>(SERVER_KEY, seedState());
}
export function loadLocal(): WorkbenchState {
  return loadJSON<WorkbenchState>(LOCAL_KEY, loadServer());
}
export function loadOutbox(): OutboxState {
  return loadJSON<OutboxState>(OUTBOX_KEY, emptyOutbox());
}
export function saveServer(s: WorkbenchState): void { saveJSON(SERVER_KEY, s); }
export function saveLocal(s: WorkbenchState): void { saveJSON(LOCAL_KEY, s); }
export function saveOutbox(o: OutboxState): void { saveJSON(OUTBOX_KEY, o); }

/** 沿 canonicalId 链解析到主记录；合并后的旧链接都通过它找到同一个主记录。 */
export function resolveCanonical(state: WorkbenchState, id: string): AuditIssue | undefined {
  let current = state.issues.find((i) => i.id === id);
  const seen = new Set<string>();
  while (current?.canonicalId && !seen.has(current.id)) {
    seen.add(current.id);
    const next = state.issues.find((i) => i.id === current!.canonicalId);
    if (!next) break;
    current = next;
  }
  return current;
}

export interface EditMeta {
  message: string;
  author: string;
  at: string;
  opId?: string;
}

/** 把一组字段修改应用到某条记录，修订号 +1，并返回写入的时间线事件。 */
export function applyEdit(
  state: WorkbenchState,
  issueId: string,
  changes: FieldChange[],
  meta: EditMeta
): { state: WorkbenchState; event: AuditEvent } {
  const s = structuredClone(state);
  const target = resolveCanonical(s, issueId) ?? s.issues.find((i) => i.id === issueId);
  if (!target) throw new Error('找不到问题记录');
  for (const c of changes) {
    (target as unknown as Record<string, unknown>)[c.field] = c.to;
  }
  target.revision += 1;
  target.updatedAt = meta.at;
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    at: meta.at,
    issueId: target.id,
    message: meta.message,
    opId: meta.opId,
    author: meta.author,
    revision: target.revision
  };
  s.events.unshift(event);
  return { state: s, event };
}

/** 新建问题：写入完整记录与创建事件。 */
export function applyCreate(
  state: WorkbenchState,
  issue: AuditIssue,
  meta: EditMeta
): { state: WorkbenchState; event: AuditEvent } {
  const s = structuredClone(state);
  s.issues.unshift(issue);
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    at: meta.at,
    issueId: issue.id,
    message: meta.message,
    opId: meta.opId,
    author: meta.author,
    revision: issue.revision
  };
  s.events.unshift(event);
  return { state: s, event };
}

export interface MergeMeta {
  author: string;
  at: string;
}

/**
 * 重复合并：把 duplicate 指向 canonical，并把 duplicate 的操作时间线改指到 canonical，
 * 再追加一条合并事件。合并后主问题、时间线、旧链接都指向同一个主记录。
 */
export function mergeIssues(
  state: WorkbenchState,
  duplicateId: string,
  canonicalId: string,
  meta: MergeMeta
): WorkbenchState {
  const s = structuredClone(state);
  const canonical = resolveCanonical(s, canonicalId);
  const duplicate = s.issues.find((i) => i.id === duplicateId);
  if (!canonical || !duplicate || duplicate.id === canonical.id) return state;
  // 旧链接指向主记录
  duplicate.canonicalId = canonical.id;
  // 操作时间线改指到主记录
  for (const ev of s.events) {
    if (ev.issueId === duplicate.id) ev.issueId = canonical.id;
  }
  canonical.revision += 1;
  canonical.updatedAt = meta.at;
  s.events.unshift({
    id: crypto.randomUUID(),
    at: meta.at,
    issueId: canonical.id,
    message: `重复问题已合并到主问题「${canonical.title}」，原记录与操作时间线已指向主记录`,
    author: meta.author,
    revision: canonical.revision
  });
  return s;
}

export interface SyncOptions {
  /** 模拟网络恢复时合并出错：首个操作写入后抛出，批次保留为 failed 可重试。 */
  forceFailure?: boolean;
}

export interface SyncResult {
  server: WorkbenchState;
  outbox: OutboxState;
  synced: number;
  conflicts: number;
  failed: boolean;
  error?: string;
}

/**
 * 把离线批次同步到服务端。按批次顺序、按原记录（issueId）应用字段修改。
 * - 字段值 === 基线值才覆盖；否则生成 FieldConflict 保留两版待审核，不整条覆盖。
 * - 已 applied 的操作凭 opId 跳过，时间线不重复追加（幂等）。
 * - 合并出错时批次保留为 failed，可重试；已写入的修改不会重复追加时间线。
 */
export function syncOutbox(
  server: WorkbenchState,
  outbox: OutboxState,
  opts: SyncOptions = {}
): SyncResult {
  const s = structuredClone(server);
  const o = structuredClone(outbox);
  let synced = 0;
  let conflictCount = 0;
  let forced = false;

  for (const batch of o.batches) {
    if (batch.status === 'applied') continue;
    batch.status = 'syncing';
    try {
      for (const op of batch.ops) {
        // 幂等：已写入的操作（含重试场景）直接跳过
        if (op.status === 'applied') {
          synced += 1;
          continue;
        }

        let eventIssueId: string;
        let eventRevision: number;

        if (op.opType === 'create') {
          // 幂等创建：服务端已有该记录则不再创建
          if (!s.issues.some((i) => i.id === op.issueId)) {
            s.issues.unshift({ ...(op.issueData as AuditIssue) });
          }
          eventIssueId = op.issueId;
          eventRevision = (op.issueData as AuditIssue).revision;
        } else {
          const target = resolveCanonical(s, op.issueId);
          if (!target) throw new Error(`找不到问题记录 ${op.issueId}`);
          let appliedAny = false;
          for (const change of op.changes) {
            const current = (target as unknown as Record<string, unknown>)[change.field];
            if (current === change.from) {
              // 服务端自基线以来未改动 -> 覆盖
              (target as unknown as Record<string, unknown>)[change.field] = change.to;
              appliedAny = true;
            } else if (current === change.to) {
              // 服务端已是目标值 -> 无需写入
              appliedAny = true;
            } else {
              // 同一字段被不同人改成不同值 -> 保留两版待审核，不覆盖
              s.conflicts.push({
                id: crypto.randomUUID(),
                issueId: target.id,
                field: change.field,
                fieldLabel: change.fieldLabel,
                baseValue: change.from,
                serverValue: current,
                localValue: change.to,
                opId: op.opId,
                author: op.author,
                at: new Date().toISOString(),
                status: 'pending'
              });
              conflictCount += 1;
            }
          }
          if (appliedAny) {
            target.revision += 1;
            target.updatedAt = new Date().toISOString();
          }
          eventIssueId = target.id;
          eventRevision = target.revision;
        }

        // 幂等追加时间线：opId 已存在则不重复写入
        if (!s.events.some((e) => e.opId === op.opId)) {
          s.events.unshift({
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            issueId: eventIssueId,
            message: op.message,
            opId: op.opId,
            author: op.author,
            revision: eventRevision
          });
        }
        op.status = conflictCount > 0 ? 'conflict' : 'applied';
        synced += 1;

        if (opts.forceFailure && !forced) {
          forced = true;
          throw new Error('合并失败：服务端返回修订号冲突，离线批次已保留，可重试');
        }
      }
      batch.status = 'applied';
      batch.error = undefined;
    } catch (err) {
      batch.status = 'failed';
      batch.error = err instanceof Error ? err.message : String(err);
      return { server: s, outbox: o, synced, conflicts: conflictCount, failed: true, error: batch.error };
    }
  }
  return { server: s, outbox: o, synced, conflicts: conflictCount, failed: false };
}

export interface ResolveConflictMeta {
  author: string;
  at: string;
}

/** 审核员处理字段冲突：采用服务端版本或本地版本，写入后修订号 +1 并追加时间线。 */
export function resolveFieldConflict(
  state: WorkbenchState,
  conflictId: string,
  choice: 'server' | 'local',
  meta: ResolveConflictMeta
): WorkbenchState {
  const s = structuredClone(state);
  const conflict = s.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.status !== 'pending') return state;
  const target = resolveCanonical(s, conflict.issueId);
  if (!target) return state;
  const value = choice === 'local' ? conflict.localValue : conflict.serverValue;
  (target as unknown as Record<string, unknown>)[conflict.field] = value;
  conflict.status = 'resolved';
  conflict.resolution = choice;
  target.revision += 1;
  target.updatedAt = meta.at;
  s.events.unshift({
    id: crypto.randomUUID(),
    at: meta.at,
    issueId: target.id,
    message: `字段「${conflict.fieldLabel}」冲突已由审核员裁定为${choice === 'local' ? '本地版本' : '服务端版本'}`,
    author: meta.author,
    revision: target.revision
  });
  return s;
}

/** 待审核冲突数。 */
export function pendingConflicts(state: WorkbenchState): number {
  return state.conflicts.filter((c) => c.status === 'pending').length;
}

/** 待同步批次数。 */
export function pendingBatches(outbox: OutboxState): number {
  return outbox.batches.filter((b) => b.status === 'queued' || b.status === 'failed').length;
}
