/**
 * 审计协作同步引擎
 *
 * 设计要点：
 * - 每条问题记录带修订号 rev；每个字段值记录“当前生效修订 + 修改人”。
 * - 离线修改进入 outbox 批次排队，携带其依据的原记录修订号 baseRev；
 *   连续修改同一字段会在未推送的批次内合并，不产生重复条目。
 * - 服务端按字段对账：baseRev 之后若被其他人改过，该字段保留两版
 *   （pending 冲突），绝不用后到内容整条覆盖。
 * - 每个操作有幂等键 opId，同一批次重试时已写入的修改和时间线不会重复追加。
 * - 重复合并把旧记录标记为主问题的别名（aliases），主问题、时间线、旧链接
 *   全部通过 resolveId 解析到同一个主记录。
 */

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export const EDITABLE_FIELDS = ['title', 'flow', 'steps', 'impactGroup', 'severity', 'status', 'fixNote', 'retestNote'] as const;
export type IssueField = (typeof EDITABLE_FIELDS)[number];

export type FieldValue = string;

/** 字段的一个候选版本（当前值或待审核版本）。 */
export interface FieldVersion {
  value: FieldValue;
  /** 写入该值时记录所在的修订号（“每条修改带修订号”）。 */
  rev: number;
  authorId: string;
  at: string;
  /** 离线批次 id，服务端处理后保留来源信息；联机即时操作为 undefined。 */
  batchId?: string;
}

export type FieldMap = Partial<Record<IssueField, FieldVersion>>;
export type PendingMap = Partial<Record<IssueField, FieldVersion[]>>;

export interface AuditIssue {
  id: string;
  rev: number;
  createdAt: string;
  createdBy: string;
  fields: FieldMap;
  /** 待审核的冲突字段：字段名 -> 其余版本（不含当前生效值）。 */
  pending: PendingMap;
  /** 非空表示该记录已作为重复项合并到主问题。 */
  canonicalId?: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  issueId: string;
  authorId: string;
  kind: 'create' | 'edit' | 'merge' | 'resolve';
  message: string;
  /** 仅排序用：同毫秒内保持操作到达顺序。 */
  clock: number;
  /** 来源批次，便于核对哪些时间线条目来自哪次离线续作。 */
  batchId?: string;
}

export type Operation =
  | { opId: string; type: 'create'; issueId: string; at: string; authorId: string; fields: FieldMap; batchId?: string }
  | {
      opId: string;
      type: 'edit';
      issueId: string;
      at: string;
      authorId: string;
      baseRev: number;
      changes: { field: IssueField; value: FieldValue; label?: string }[];
      /** 可选的业务动作描述（如“审核员完成分诊”），缺省时按字段名生成。 */
      message?: string;
      batchId?: string
    }
  | { opId: string; type: 'merge'; duplicateId: string; canonicalId: string; at: string; authorId: string; baseRev: number; batchId?: string }
  | {
      opId: string;
      type: 'resolve';
      issueId: string;
      at: string;
      authorId: string;
      field: IssueField;
      choice: { kind: 'keep-current' } | { kind: 'version'; version: FieldVersion };
      batchId?: string
    };

export interface ServerState {
  issues: Record<string, AuditIssue>;
  events: TimelineEvent[];
  /** id -> 当前主记录 id，重复合并时写入，供旧链接解析。 */
  aliases: Record<string, string>;
  appliedOps: Record<string, boolean>;
  clock: number;
}

export type BatchStatus = 'queued' | 'failed' | 'applied';

export interface OutboxBatch {
  id: string;
  authorId: string;
  createdAt: string;
  status: BatchStatus;
  /** 断网期间打开的批次；恢复网络前持续追加，推送后置为 false。 */
  open: boolean;
  ops: Operation[];
  /** 合并失败时记录原因，批次保留以便重试。 */
  lastError?: string;
  /** 推送进度：已经过幂等处理的操作数，重试从这里继续。 */
  appliedCount: number;
}

export interface Replica {
  authorId: string;
  /** 上次成功同步后的服务端快照。 */
  snapshot: ServerState;
  outbox: OutboxBatch[];
}

export interface ApplyOutcome {
  applied: boolean;
  kind: Operation['type'];
  /** edit 操作中产生冲突的字段。 */
  conflicts: IssueField[];
  /** edit 操作中被判定为空操作（没有任何字段变化）。 */
  noop: boolean;
  error?: string;
}

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}-${counter}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 旧链接 / 重复 id 解析到当前主记录（沿 aliases 链，带环保护）。 */
export function resolveId(server: ServerState, id: string): string {
  let current = id;
  for (let i = 0; i < 32; i += 1) {
    const next = server.aliases[current];
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

export function getIssue(server: ServerState, idOrAlias: string): AuditIssue | undefined {
  return server.issues[resolveId(server, idOrAlias)];
}

export function fieldValue(issue: AuditIssue, field: IssueField): string {
  return issue.fields[field]?.value ?? '';
}

export function hasPendingConflicts(issue: AuditIssue): boolean {
  return Object.values(issue.pending).some((versions) => versions && versions.length > 0);
}

export function pendingCount(issue: AuditIssue): number {
  return Object.values(issue.pending).reduce((sum, versions) => sum + (versions?.length ?? 0), 0);
}

export function allIssues(server: ServerState): AuditIssue[] {
  return Object.values(server.issues).sort((a, b) => (fieldValue(a, 'title') < fieldValue(b, 'title') ? -1 : 1));
}

export function canonicalIssues(server: ServerState): AuditIssue[] {
  return allIssues(server).filter((issue) => !issue.canonicalId);
}

function nextClock(server: ServerState): number {
  server.clock += 1;
  return server.clock;
}

function pushEvent(server: ServerState, event: Omit<TimelineEvent, 'id' | 'clock'> & { id?: string }): TimelineEvent {
  const full: TimelineEvent = {
    id: event.id ?? uid('e'),
    at: event.at,
    issueId: event.issueId,
    authorId: event.authorId,
    kind: event.kind,
    message: event.message,
    batchId: event.batchId,
    clock: nextClock(server)
  };
  server.events.push(full);
  return full;
}

/** 某字段在 baseRev 之后是否被“别人”写过（含通过冲突裁决采纳别人版本）。 */
function touchedByOtherAfter(issue: AuditIssue, field: IssueField, baseRev: number, authorId: string): boolean {
  const current = issue.fields[field];
  if (current && current.rev > baseRev && current.authorId !== authorId) return true;
  const pendings = issue.pending[field];
  if (pendings?.some((version) => version.rev > baseRev && version.authorId !== authorId)) return true;
  return false;
}

function describeChanges(changes: { field: IssueField; value: FieldValue; label?: string }[]): string {
  return changes.map((change) => change.label ?? change.field).join('、');
}

/**
 * 在服务端状态上应用单个操作（就地修改）。幂等：相同 opId 的重复投递直接跳过，
 * 时间线也不会重复追加。返回失败时 error 非空，且不改变状态。
 */
export function applyOperation(server: ServerState, op: Operation): ApplyOutcome {
  if (server.appliedOps[op.opId]) {
    return { applied: false, kind: op.type, conflicts: [], noop: true };
  }

  const outcome = dispatchOperation(server, op);
  // 只在操作真正生效（或判定为空操作）后记幂等键；业务失败不登记，批次可原样重试。
  if (!outcome.error) server.appliedOps[op.opId] = true;
  return outcome;
}

function dispatchOperation(server: ServerState, op: Operation): ApplyOutcome {
  if (op.type === 'create') {
    const existing = server.issues[op.issueId];
    if (existing) {
      return { applied: false, kind: 'create', conflicts: [], noop: true };
    }
    const issue: AuditIssue = {
      id: op.issueId,
      rev: 0,
      createdAt: op.at,
      createdBy: op.authorId,
      fields: op.fields,
      pending: {}
    };
    server.issues[issue.id] = issue;
    pushEvent(server, {
      at: op.at,
      issueId: issue.id,
      authorId: op.authorId,
      kind: 'create',
      message: '审计员创建问题并保存证据',
      batchId: op.batchId
    });
    return { applied: true, kind: 'create', conflicts: [], noop: false };
  }

  if (op.type === 'edit') {
    const targetId = resolveId(server, op.issueId);
    const issue = server.issues[targetId];
    if (!issue) {
      return { applied: false, kind: 'edit', conflicts: [], noop: false, error: `目标问题 ${op.issueId} 已不存在，无法对账` };
    }
    const conflicts: IssueField[] = [];
    const conflictChanges: { field: IssueField; value: FieldValue; label?: string }[] = [];
    const effective: { field: IssueField; value: FieldValue; label?: string }[] = [];
    // 先纯计算，所有判定通过后再提交修改，保证失败/空操作不留脏数据。
    const writes: { field: IssueField; candidate: FieldVersion }[] = [];
    const pendingAdds: { field: IssueField; candidate: FieldVersion }[] = [];
    for (const change of op.changes) {
      const current = issue.fields[change.field];
      const candidate: FieldVersion = {
        value: change.value,
        rev: issue.rev + writes.length + 1,
        authorId: op.authorId,
        at: op.at,
        batchId: op.batchId
      };
      // 同值为空操作：不升修订号，也不写时间线字段。
      if (current && current.value === change.value) continue;
      if (!current) {
        // 字段从未填写，直接生效。
        writes.push({ field: change.field, candidate });
        effective.push(change);
        continue;
      }
      if (current.rev <= op.baseRev) {
        // 快进：依据的原记录之后该字段没人改过，正常写入并升修订号。
        writes.push({ field: change.field, candidate });
        effective.push(change);
        continue;
      }
      // 原记录之后被同一人连续改过：离线续作合并，按最新提交快进，不算冲突。
      if (!touchedByOtherAfter(issue, change.field, op.baseRev, op.authorId)) {
        writes.push({ field: change.field, candidate });
        effective.push(change);
        continue;
      }
      // 同一字段被不同人改过：保留两版待审核，不能后到整条覆盖。
      const list = issue.pending[change.field] ?? [];
      if (!list.some((version) => version.authorId === op.authorId && version.value === change.value && version.batchId === op.batchId)) {
        pendingAdds.push({ field: change.field, candidate });
        conflicts.push(change.field);
        conflictChanges.push(change);
      }
    }

    if (effective.length === 0 && conflicts.length === 0) {
      return { applied: false, kind: 'edit', conflicts: [], noop: true };
    }
    for (const { field, candidate } of writes) {
      issue.fields[field] = candidate;
      if (candidate.rev > issue.rev) issue.rev = candidate.rev;
    }
    for (const { field, candidate } of pendingAdds) {
      const list = issue.pending[field] ?? [];
      list.push(candidate);
      issue.pending[field] = list;
    }
    const parts: string[] = [];
    if (op.message) {
      parts.push(op.message);
    } else if (effective.length > 0) {
      parts.push(`更新 ${describeChanges(effective)}`);
    }
    if (conflictChanges.length > 0) parts.push(`字段冲突待审核：${describeChanges(conflictChanges)}`);
    pushEvent(server, {
      at: op.at,
      issueId: targetId,
      authorId: op.authorId,
      kind: 'edit',
      message: parts.join('；'),
      batchId: op.batchId
    });
    return { applied: true, kind: 'edit', conflicts, noop: false };
  }

  if (op.type === 'merge') {
    // duplicateId 必须直接命中一条尚未归并的记录：旧链接/别名已指向主问题，
    // 不能沿别名链把主问题本身再次挂走。
    const duplicate = server.issues[op.duplicateId];
    const canonicalId = resolveId(server, op.canonicalId);
    const canonical = server.issues[canonicalId];
    if (!duplicate) return { applied: false, kind: 'merge', conflicts: [], noop: false, error: '被合并的重复问题不存在' };
    if (duplicate.canonicalId) {
      return {
        applied: false,
        kind: 'merge',
        conflicts: [],
        noop: false,
        error: `该问题已合并到主记录 ${duplicate.canonicalId}，不能重复合并`
      };
    }
    if (!canonical) {
      // 合并失败的典型场景：离线期间主记录在服务端不可见（演示用失败注入也走这里）。
      return { applied: false, kind: 'merge', conflicts: [], noop: false, error: `主问题 ${op.canonicalId} 不存在，合并未执行` };
    }
    if (op.duplicateId === canonicalId) {
      return { applied: false, kind: 'merge', conflicts: [], noop: false, error: '不能把问题合并到自身' };
    }
    duplicate.canonicalId = canonicalId;
    server.aliases[op.duplicateId] = canonicalId;
    // 主问题、操作时间线：重复项的时间线仍保留原 issueId，但 resolveId
    // 会把它和旧链接一起带到主记录视图。
    const canonicalTitle = fieldValue(canonical, 'title');
    pushEvent(server, {
      at: op.at,
      issueId: canonicalId,
      authorId: op.authorId,
      kind: 'merge',
      message: `重复问题已合并到主问题「${canonicalTitle}」，旧记录与链接指向主记录`,
      batchId: op.batchId
    });
    pushEvent(server, {
      at: op.at,
      issueId: op.duplicateId,
      authorId: op.authorId,
      kind: 'merge',
      message: `标记为「${canonicalTitle}」的重复项并完成归并`,
      batchId: op.batchId
    });
    return { applied: true, kind: 'merge', conflicts: [], noop: false };
  }

  // resolve：审核员对字段冲突作出裁决，所有时间线写入仍走幂等通道。
  const issue = server.issues[resolveId(server, op.issueId)];
  if (!issue) return { applied: false, kind: 'resolve', conflicts: [], noop: false, error: '目标问题不存在' };
  const pendingVersions = issue.pending[op.field] ?? [];
  const previous = issue.fields[op.field];
  let adopted: FieldVersion | undefined;
  if (op.choice.kind === 'version') {
    const wanted = op.choice.version;
    adopted =
      pendingVersions.find(
        (version) =>
          version.authorId === wanted.authorId && version.value === wanted.value && version.at === wanted.at
      ) ??
      (previous &&
      previous.authorId === wanted.authorId &&
      previous.value === wanted.value &&
      previous.at === wanted.at
        ? previous
        : undefined);
  }
  if (op.choice.kind === 'version' && adopted) {
    issue.fields[op.field] = { ...adopted, rev: issue.rev + 1, at: op.at };
    issue.rev += 1;
  }
  delete issue.pending[op.field];
  pushEvent(server, {
    at: op.at,
    issueId: issue.id,
    authorId: op.authorId,
    kind: 'resolve',
    message:
      op.choice.kind === 'keep-current' || !adopted
        ? `审核员裁决保留当前版本（${previous?.authorId ?? '未知'} 的修改），驳回其余版本`
        : `审核员裁决采纳 ${adopted.authorId} 对字段的版本，冲突已解决`,
    batchId: op.batchId
  });
  return { applied: true, kind: 'resolve', conflicts: [], noop: false };
}

/**
 * 推送一个离线批次。中途失败时保留批次（含已应用进度），调用方可原样重试：
 * 已写入的修改靠 opId 幂等跳过，时间线不会重复追加。
 *
 * failOnOpId 用于演示“合并失败后保留批次并可重试”。
 */
export function pushBatch(server: ServerState, batch: OutboxBatch, failOnOpId?: string): ServerState {
  let index = 0;
  try {
    for (; index < batch.ops.length; index += 1) {
      const op = batch.ops[index];
      const outcome = applyOperation(server, op);
      if (outcome.error) throw new Error(outcome.error);
      if (failOnOpId === op.opId) throw new Error('模拟网络故障：服务端暂时无法完成合并');
      batch.appliedCount = index + 1;
    }
  } catch (error) {
    batch.status = 'failed';
    batch.open = false;
    batch.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  batch.status = 'applied';
  batch.open = false;
  batch.lastError = undefined;
  return server;
}

/** 时间线：主问题视图同时包含主记录与所有重复项（旧链接指向同一处）。 */
export function eventsForIssue(server: ServerState, issueId: string): TimelineEvent[] {
  const canonicalId = resolveId(server, issueId);
  return server.events
    .filter((event) => resolveId(server, event.issueId) === canonicalId)
    .sort((a, b) => (a.at === b.at ? b.clock - a.clock : a.at < b.at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// 副本侧：排队、批次合并、视图派生
// ---------------------------------------------------------------------------

export function cloneServer(server: ServerState): ServerState {
  return JSON.parse(JSON.stringify(server)) as ServerState;
}

/** 把单个操作并入副本的待发批次：离线时按原记录排队，同字段连续修改就地合并。 */
export function queueOperation(replica: Replica, op: Operation, online: boolean): OutboxBatch {
  let batch = replica.outbox.find((item) => item.open && item.status === 'queued');
  if (online) {
    // 联机时每个操作自成一个已关闭批次，仍然排队等待推送（统一续作通道）。
    batch = { id: uid('batch'), authorId: replica.authorId, createdAt: op.at, status: 'queued', open: false, ops: [], appliedCount: 0 };
    replica.outbox.push(batch);
  } else if (!batch) {
    batch = { id: uid('batch'), authorId: replica.authorId, createdAt: op.at, status: 'queued', open: true, ops: [], appliedCount: 0 };
    replica.outbox.push(batch);
  }
  op.batchId = batch.id;

  if (op.type === 'edit') {
    const existing = batch.ops.find(
      (item): item is Extract<Operation, { type: 'edit' }> =>
        item.type === 'edit' && item.issueId === op.issueId && item.baseRev === op.baseRev
    );
    if (existing) {
      for (const change of op.changes) {
        const atIndex = existing.changes.findIndex((item) => item.field === change.field);
        if (atIndex >= 0) existing.changes[atIndex] = change;
        else existing.changes.push(change);
      }
    } else {
      batch.ops.push(op);
    }
  } else {
    batch.ops.push(op);
  }
  return batch;
}

export function pendingEventCount(replica: Replica): number {
  return replica.outbox
    .filter((batch) => batch.status === 'queued' || batch.status === 'failed')
    .reduce((sum, batch) => sum + batch.ops.length - batch.appliedCount, 0);
}

export function failedBatchCount(replica: Replica): number {
  return replica.outbox.filter((batch) => batch.status === 'failed').length;
}

/**
 * 副本视图：快照 + 尚未推送的 outbox 操作依次叠加（不修改快照），
 * 让审核员离线时也能看到自己的续作；时间线额外标注“待同步”。
 */
export function deriveView(replica: Replica): ServerState {
  const view = cloneServer(replica.snapshot);
  for (const batch of replica.outbox) {
    for (let i = 0; i < batch.ops.length; i += 1) {
      const op = batch.ops[i];
      const alreadyApplied = i < batch.appliedCount || view.appliedOps[op.opId];
      if (alreadyApplied) continue;
      applyOperation(view, op);
    }
  }
  return view;
}

export function isOpPending(replica: Replica, opId: string): boolean {
  return replica.outbox.some(
    (batch) =>
      (batch.status === 'queued' || batch.status === 'failed') &&
      batch.ops.some((op, index) => op.opId === opId && index >= batch.appliedCount)
  );
}

// ---------------------------------------------------------------------------
// 初始演示数据
// ---------------------------------------------------------------------------

export function createSeedServer(now = nowIso()): ServerState {
  const server: ServerState = { issues: {}, events: [], aliases: {}, appliedOps: {}, clock: 0 };
  const f = (value: FieldValue, authorId: string, at: string): FieldVersion => ({ value, rev: 0, authorId, at });
  const issue1: AuditIssue = {
    id: 'issue-1',
    rev: 0,
    createdAt: now,
    createdBy: 'auditor-a',
    pending: {},
    fields: {
      title: f('结算弹窗关闭后焦点丢失', 'auditor-a', now),
      flow: f('订单结算', 'auditor-a', now),
      steps: f('1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', 'auditor-a', now),
      impactGroup: f('键盘与读屏用户', 'auditor-a', now),
      severity: f('serious', 'auditor-a', now),
      status: f('triaged', 'auditor-a', now),
      fixNote: f('', 'auditor-a', now),
      retestNote: f('', 'auditor-a', now)
    }
  };
  const issue2: AuditIssue = {
    id: 'issue-2',
    rev: 0,
    createdAt: now,
    createdBy: 'auditor-a',
    pending: {},
    fields: {
      title: f('错误提示未与输入框关联', 'auditor-a', now),
      flow: f('账户设置', 'auditor-a', now),
      steps: f('输入无效手机号后使用读屏读取输入框', 'auditor-a', now),
      impactGroup: f('读屏用户', 'auditor-a', now),
      severity: f('moderate', 'auditor-a', now),
      status: f('fixing', 'auditor-a', now),
      fixNote: f('已增加 aria-describedby，等待构建', 'auditor-b', now),
      retestNote: f('', 'auditor-a', now)
    }
  };
  server.issues[issue1.id] = issue1;
  server.issues[issue2.id] = issue2;
  pushEvent(server, { at: now, issueId: 'issue-1', authorId: 'auditor-a', kind: 'create', message: '审计员创建问题并保存证据' });
  pushEvent(server, { at: now, issueId: 'issue-2', authorId: 'auditor-a', kind: 'create', message: '审计员创建问题并保存证据' });
  return server;
}

export const AUTHORS: Record<string, { name: string }> = {
  'auditor-a': { name: '审核员甲' },
  'auditor-b': { name: '审核员乙' },
  'auditor-c': { name: '审核员丙' }
};

export function authorName(authorId: string): string {
  return AUTHORS[authorId]?.name ?? authorId;
}

export const FIELD_LABELS: Record<IssueField, string> = {
  title: '问题标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '影响人群',
  severity: '严重程度',
  status: '问题状态',
  fixNote: '修复记录',
  retestNote: '复测记录'
};
