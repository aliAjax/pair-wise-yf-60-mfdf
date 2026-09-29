import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createForm, zodForm, setValue } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  type AuditIssue,
  type AuditEvent,
  type FieldChange,
  type ChangeOperation,
  type WorkbenchState,
  type OutboxState,
  type NetworkStatus,
  type Severity,
  FIELD_LABELS,
  loadServer,
  loadLocal,
  loadOutbox,
  saveServer,
  saveLocal,
  saveOutbox,
  applyEdit,
  applyCreate,
  mergeIssues,
  syncOutbox,
  resolveFieldConflict,
  resolveCanonical,
  pendingConflicts,
  pendingBatches
} from '~/lib/collab';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));

  // 服务端副本（共享事实来源）、本地工作副本（离线可编辑）、离线批次队列
  const [server, setServer] = createStore<WorkbenchState>(loadServer());
  const [local, setLocal] = createStore<WorkbenchState>(loadLocal());
  const [outbox, setOutbox] = createStore<OutboxState>(loadOutbox());

  const [network, setNetwork] = createSignal<NetworkStatus>('online');
  const [forceFailure, setForceFailure] = createSignal(false);
  const [author, setAuthor] = createSignal('审核员');
  const [selectedId, setSelectedId] = createSignal(local.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [syncMsg, setSyncMsg] = createSignal('');

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  // 持久化
  createEffect(() => saveServer(server));
  createEffect(() => saveLocal(local));
  createEffect(() => saveOutbox(outbox));

  const selectedRaw = createMemo(() => local.issues.find((issue) => issue.id === selectedId()));
  const selected = createMemo(() => resolveCanonical(local, selectedId()) ?? selectedRaw());
  const isMergedView = createMemo(() => !!selectedRaw()?.canonicalId && selectedRaw()!.canonicalId !== selected()?.id);

  const conflictCount = createMemo(() => pendingConflicts(server));
  const pendingBatchCount = createMemo(() => pendingBatches(outbox));

  const commitServer = (next: WorkbenchState) => {
    setServer(next);
    setLocal(structuredClone(next));
  };
  const commitLocal = (next: WorkbenchState) => setLocal(next);

  /** 把离线操作按原记录（issueId）排入队列：同一问题的离线修改归到一个 queued 批次。 */
  const enqueueOp = (op: ChangeOperation) => {
    setOutbox('batches', (batches) => {
      const existing = batches.find((b) => b.status === 'queued' && b.ops.some((o) => o.issueId === op.issueId));
      if (existing) {
        return batches.map((b) => (b.batchId === existing.batchId ? { ...b, ops: [...b.ops, op] } : b));
      }
      return [...batches, { batchId: crypto.randomUUID(), createdAt: new Date().toISOString(), ops: [op], status: 'queued' }];
    });
  };

  /** 在线：直接写入服务端；离线：乐观写入本地并排队。每条修改都带修订号。 */
  const editIssue = (issueId: string, changes: FieldChange[], message: string) => {
    const now = new Date().toISOString();
    const target = resolveCanonical(local, issueId) ?? local.issues.find((i) => i.id === issueId);
    const baseRevision = target?.revision ?? 1;
    if (network() === 'online') {
      const { state: next } = applyEdit(server, issueId, changes, { message, author: author(), at: now });
      commitServer(next);
    } else {
      const { state: next } = applyEdit(local, issueId, changes, { message, author: author(), at: now });
      commitLocal(next);
      const op: ChangeOperation = {
        opId: crypto.randomUUID(),
        opType: 'edit',
        issueId,
        baseRevision,
        changes,
        author: author(),
        at: now,
        message,
        status: 'pending'
      };
      enqueueOp(op);
    }
  };

  const createIssue = (values: IssueForm) => {
    const now = new Date().toISOString();
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      title: values.title,
      flow: values.flow,
      steps: values.steps,
      impactGroup: values.impactGroup,
      severity: values.severity,
      status: 'open',
      fixNote: '',
      retestNote: '',
      revision: 1,
      updatedAt: now
    };
    if (network() === 'online') {
      const { state: next } = applyCreate(server, issue, { message: '审计员创建问题并保存证据', author: author(), at: now });
      commitServer(next);
    } else {
      const { state: next } = applyCreate(local, issue, { message: '审计员创建问题并保存证据', author: author(), at: now });
      commitLocal(next);
      const op: ChangeOperation = {
        opId: crypto.randomUUID(),
        opType: 'create',
        issueId: issue.id,
        baseRevision: 0,
        changes: [],
        issueData: issue,
        author: author(),
        at: now,
        message: '审计员创建问题并保存证据',
        status: 'pending'
      };
      enqueueOp(op);
    }
    setSelectedId(issue.id);
  };

  /** 网络恢复后同步离线批次；合并失败则保留批次，可重试。 */
  const sync = () => {
    const result = syncOutbox(server, outbox, { forceFailure: forceFailure() });
    commitServer(result.server);
    setOutbox(result.outbox);
    if (result.failed) {
      setSyncMsg(`同步失败：${result.error}（已保留 ${result.outbox.batches.filter((b) => b.status === 'failed').length} 个批次，可重试）`);
    } else if (result.conflicts > 0) {
      setSyncMsg(`同步完成：${result.synced} 项已写入，${result.conflicts} 个字段冲突待审核`);
    } else if (result.synced > 0) {
      setSyncMsg(`同步完成：${result.synced} 项修改已写入`);
    } else {
      setSyncMsg('没有待同步的离线批次');
    }
  };

  /** 重试失败批次：置回 queued 后重新同步；已写入的修改凭 opId 跳过，不重复追加时间线。 */
  const retryBatch = (batchId: string) => {
    setOutbox('batches', (batches) => batches.map((b) => (b.batchId === batchId ? { ...b, status: 'queued', error: undefined } : b)));
    sync();
  };

  const toggleNetwork = () => {
    if (network() === 'online') {
      setNetwork('offline');
      setSyncMsg('已进入离线模式：修改将排队，恢复网络后同步');
    } else {
      setNetwork('online');
      sync();
    }
  };

  /** 审核员裁定字段冲突：采用服务端版本或本地版本。 */
  const resolveConflict = (conflictId: string, choice: 'server' | 'local') => {
    const now = new Date().toISOString();
    const next = resolveFieldConflict(server, conflictId, choice, { author: author(), at: now });
    commitServer(next);
  };

  /** 重复合并：主问题、操作时间线、旧链接都指向同一个主记录。 */
  const mergeDuplicate = () => {
    const duplicate = selectedRaw();
    const canonical = local.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    const now = new Date().toISOString();
    const next = mergeIssues(server, duplicate.id, canonical.id, { author: author(), at: now });
    commitServer(next);
    setSelectedId(canonical.id);
    setMergeInto('');
    setSyncMsg(`已合并到主问题「${canonical.title}」，时间线与旧链接已指向主记录`);
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { queued: '已排队', syncing: '同步中', applied: '已应用', failed: '失败待重试', conflict: '有冲突' };
    return map[status] ?? status;
  };

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="card netbar" aria-label="网络与离线协作">
          <div class="netbar-row">
            <span class={`net-dot ${network() === 'online' ? 'online' : 'offline'}`}>{network() === 'online' ? '在线' : '离线'}</span>
            <label class="inline">审核员<input value={author()} onInput={(e) => setAuthor(e.currentTarget.value)} /></label>
            <label class="inline"><input type="checkbox" checked={forceFailure()} onChange={(e) => setForceFailure(e.currentTarget.checked)} />模拟网络恢复时合并失败</label>
            <button class="secondary" onClick={toggleNetwork}>{network() === 'online' ? '切换到离线' : '恢复网络'}</button>
            <button onClick={sync} disabled={pendingBatchCount() === 0}>同步离线批次{pendingBatchCount() > 0 ? `（${pendingBatchCount()}）` : ''}</button>
          </div>
          <Show when={syncMsg()}><p class="sync-msg" role="status">{syncMsg()}</p></Show>
        </section>

        <Show when={conflictCount() > 0}>
          <section class="card conflict-banner" aria-label="字段冲突待审核">
            <strong>有 {conflictCount()} 个字段冲突待审核</strong>
            <p>同一字段被不同审核员改成不同值，已保留两版，未整条覆盖。请到「冲突待审」标签页裁定。</p>
          </section>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{local.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{local.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{local.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{local.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{network() === 'online' ? '同步正常' : '离线编辑中'}</small></h2>
            <For each={local.issues}>{(issue) => {
              const isMerged = !!issue.canonicalId;
              return (
                <article class="issue" classList={{ merged: isMerged }}>
                  <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                  <div class="meta">
                    <span class="badge">{issue.status}</span>
                    <span class="badge">{issue.severity}</span>
                    <span class="badge rev">v{issue.revision}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={isMerged}><span class="badge merged-badge">已合并</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              const raw = selectedRaw();
              return (
                <>
                  <Show when={isMergedView()}>
                    <p class="merge-banner" role="status">此问题已合并到主问题「{issue.title}」，操作时间线与旧链接已指向主记录。</p>
                  </Show>
                  <h3>{issue.title} <span class="badge rev">v{issue.revision}</span></h3>
                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                  <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                  <div role="group" aria-label="问题状态操作">
                    <button onClick={() => editIssue(issue.id, [{ field: 'status', fieldLabel: FIELD_LABELS.status, from: issue.status, to: 'triaged' }], '审核员完成分诊')}>确认问题</button>{' '}
                    <button onClick={() => editIssue(issue.id, [
                      { field: 'status', fieldLabel: FIELD_LABELS.status, from: issue.status, to: 'fixing' },
                      { field: 'fixNote', fieldLabel: FIELD_LABELS.fixNote, from: issue.fixNote, to: '修复进行中，等待提交复测版本' }
                    ], '开发人员开始修复')}>开始修复</button>{' '}
                    <button onClick={() => editIssue(issue.id, [{ field: 'status', fieldLabel: FIELD_LABELS.status, from: issue.status, to: 'verifying' }], '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                    <button onClick={() => editIssue(issue.id, [
                      { field: 'status', fieldLabel: FIELD_LABELS.status, from: issue.status, to: 'closed' },
                      { field: 'retestNote', fieldLabel: FIELD_LABELS.retestNote, from: issue.retestNote, to: '键盘、读屏和错误提示均已通过' }
                    ], '复测通过并关闭问题')}>复测通过</button>{' '}
                    <button class="danger" onClick={() => editIssue(issue.id, [
                      { field: 'status', fieldLabel: FIELD_LABELS.status, from: issue.status, to: 'reopened' },
                      { field: 'retestNote', fieldLabel: FIELD_LABELS.retestNote, from: issue.retestNote, to: '焦点顺序仍不正确' }
                    ], '复测失败并重新打开')}>复测失败</button>
                  </div>
                  <hr />
                  <label>合并到主问题
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择问题</option>
                      <For each={local.issues.filter((item) => item.id !== raw?.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                    </select>
                  </label>
                  <button disabled={!mergeInto() || isMergedView()} onClick={mergeDuplicate}>确认重复合并</button>
                </>
              );
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => setValue(form, 'title', event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => setValue(form, 'flow', event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="steps">{(field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => setValue(form, 'steps', event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field) => <label>影响人群<select value={field.value} onChange={(event) => setValue(form, 'impactGroup', event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field) => <label>严重程度<select value={field.value} onChange={(event) => setValue(form, 'severity', event.currentTarget.value as Severity)}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List>
                <Tabs.Trigger value="activity">操作记录</Tabs.Trigger>
                <Tabs.Trigger value="outbox">离线批次{pendingBatchCount() > 0 ? `（${pendingBatchCount()}）` : ''}</Tabs.Trigger>
                <Tabs.Trigger value="conflicts">冲突待审{conflictCount() > 0 ? `（${conflictCount()}）` : ''}</Tabs.Trigger>
                <Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={local.events.slice(0, 15)}>{(event: AuditEvent) => {
                    const issue = local.issues.find((i) => i.id === event.issueId);
                    return (
                      <div class="timeline-item">
                        <div class="timeline-head">
                          <strong>{new Date(event.at).toLocaleString()}</strong>
                          <Show when={event.author}><span class="badge">{event.author}</span></Show>
                          <Show when={event.revision}><span class="badge rev">v{event.revision}</span></Show>
                          <Show when={issue}><span class="timeline-issue">{issue!.title}</span></Show>
                        </div>
                        <div>{event.message}</div>
                      </div>
                    );
                  }}</For>
                </div>
              </Tabs.Content>

              <Tabs.Content value="outbox">
                <Show when={outbox.batches.length === 0} fallback={
                  <div class="outbox-list">
                    <For each={outbox.batches}>{(batch) => (
                      <div class="outbox-batch" classList={{ failed: batch.status === 'failed' }}>
                        <div class="outbox-head">
                          <span class="badge">{statusBadge(batch.status)}</span>
                          <span class="outbox-time">{new Date(batch.createdAt).toLocaleString()}</span>
                          <Show when={batch.status === 'failed'}><button class="secondary small" onClick={() => retryBatch(batch.batchId)}>重试</button></Show>
                        </div>
                        <Show when={batch.error}><p class="error" role="alert">{batch.error}</p></Show>
                        <ul class="outbox-ops">
                          <For each={batch.ops}>{(op) => {
                            const issue = local.issues.find((i) => i.id === op.issueId);
                            return (
                              <li>
                                <span class="badge rev">{op.opType === 'create' ? '新建' : '编辑'}</span>
                                <Show when={issue}><span>{issue!.title}</span></Show>
                                <span class="badge">{statusBadge(op.status)}</span>
                                <span class="outbox-msg">{op.message}</span>
                              </li>
                            );
                          }}</For>
                        </ul>
                      </div>
                    )}</For>
                  </div>
                }>
                  <p role="status">暂无离线批次。离线时的修改会按问题排队，恢复网络后同步。</p>
                </Show>
              </Tabs.Content>

              <Tabs.Content value="conflicts">
                <Show when={server.conflicts.filter((c) => c.status === 'pending').length === 0} fallback={
                  <div class="conflict-list">
                    <For each={server.conflicts.filter((c) => c.status === 'pending')}>{(c) => {
                      const issue = local.issues.find((i) => i.id === c.issueId);
                      return (
                        <div class="conflict-item">
                          <div class="conflict-head">
                            <strong>{c.fieldLabel}</strong>
                            <Show when={issue}><span class="timeline-issue">{issue!.title}</span></Show>
                            <span class="badge">{c.author}</span>
                          </div>
                          <div class="conflict-versions">
                            <div class="conflict-version"><span class="version-tag">基线</span><code>{String(c.baseValue || '（空）')}</code></div>
                            <div class="conflict-version"><span class="version-tag server">服务端版本</span><code>{String(c.serverValue || '（空）')}</code></div>
                            <div class="conflict-version"><span class="version-tag local">本地版本</span><code>{String(c.localValue || '（空）')}</code></div>
                          </div>
                          <div class="conflict-actions">
                            <button class="secondary small" onClick={() => resolveConflict(c.id, 'server')}>保留服务端版本</button>
                            <button class="small" onClick={() => resolveConflict(c.id, 'local')}>采用本地版本</button>
                          </div>
                        </div>
                      );
                    }}</For>
                  </div>
                }>
                  <p role="status">暂无待审核的字段冲突。</p>
                </Show>
              </Tabs.Content>

              <Tabs.Content value="keyboard">
                <ul>
                  <li><kbd>N</kbd>：聚焦新建问题标题</li>
                  <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li>
                  <li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li>
                  <li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li>
                </ul>
              </Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
