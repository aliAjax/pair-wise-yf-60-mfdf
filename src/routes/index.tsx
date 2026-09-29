import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  AUTHORS,
  EDITABLE_FIELDS,
  FIELD_LABELS,
  type AuditIssue,
  type FieldVersion,
  type IssueField,
  type IssueStatus,
  type Operation,
  type OutboxBatch,
  type Replica,
  type ServerState,
  type Severity,
  allIssues,
  authorName,
  canonicalIssues,
  deriveView,
  eventsForIssue,
  fieldValue,
  getIssue,
  hasPendingConflicts,
  pendingCount,
  pushBatch,
  queueOperation,
  resolveId,
  uid
} from '~/lib/collab';
import {
  armFailNext,
  consumeFailNext,
  loadActiveAuthor,
  loadOnline,
  loadReplica,
  loadServer,
  resetAll,
  saveActiveAuthor,
  saveOnline,
  saveReplica,
  saveServer
} from '~/lib/store';

const setFieldValue = (field: { value: unknown }, value: string) => {
  (field as { value: string }).value = value;
};

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

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));

  // --- “服务端”：所有审核员回到网络后对账的共同记录（本演示放在 localStorage） ---
  const [server, setServer] = createStore<ServerState>(loadServer());
  const [online, setOnline] = createSignal(loadOnline());
  const [activeAuthor, setActiveAuthor] = createSignal(loadActiveAuthor());
  const [replica, setReplica] = createStore<Replica>(loadReplica(activeAuthor(), server as ServerState));
  const [notice, setNotice] = createSignal<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncing, setSyncing] = createSignal(false);

  const initialIssue = canonicalIssues(server as ServerState)[0] ?? allIssues(server as ServerState)[0];
  const [selectedId, setSelectedId] = createSignal(initialIssue?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');

  // 本地视图 = 服务端快照 + 未推送的离线批次叠加
  const view = createMemo<ServerState>(() => deriveView(replica));
  const viewIssues = createMemo(() => allIssues(view()));
  const selected = createMemo<AuditIssue | undefined>(() => {
    const current = getIssue(view(), selectedId());
    if (current) return current;
    const first = canonicalIssues(view())[0];
    return first;
  });
  const selectedIsAlias = createMemo(() => {
    const raw = selectedId();
    return raw !== resolveId(server as ServerState, raw);
  });

  const failedBatches = createMemo(() => replica.outbox.filter((batch) => batch.status === 'failed'));
  const pendingOpsCount = createMemo(() =>
    replica.outbox.reduce((sum, batch) => sum + batch.ops.length - batch.appliedCount, 0)
  );
  const conflictIssues = createMemo(() => viewIssues().filter((issue) => hasPendingConflicts(issue)));

  createEffect(() => saveServer(server as ServerState));
  createEffect(() => saveReplica(replica));
  createEffect(() => saveOnline(online()));
  createEffect(() => saveActiveAuthor(activeAuthor()));

  const [, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const flash = (kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((current) => (current?.text === text ? null : current)), 5000);
  };

  // --- 操作入队：每条修改带 opId 与原记录修订号 baseRev ---
  const enqueue = (op: Operation): void => {
    setReplica(
      produce((draft) => {
        queueOperation(draft, op, online());
      })
    );
  };

  const baseRevOf = (issueId: string): number => {
    // 始终按“原记录”（服务端快照）修订号排队，离线期间本地续作不改 baseRev。
    const serverIssue = getIssue(replica.snapshot, issueId) ?? getIssue(server as ServerState, issueId);
    return serverIssue?.rev ?? 0;
  };

  const editIssue = (
    issueId: string,
    values: Partial<Record<IssueField, string>>,
    message?: string
  ) => {
    const changes = Object.entries(values)
      .filter(([field]) => (EDITABLE_FIELDS as readonly string[]).includes(field))
      .map(([field, value]) => ({ field: field as IssueField, value: value as string, label: FIELD_LABELS[field as IssueField] }));
    if (changes.length === 0) return;
    enqueue({
      opId: uid('op'),
      type: 'edit',
      issueId: resolveId(replica.snapshot, issueId),
      at: new Date().toISOString(),
      authorId: activeAuthor(),
      baseRev: baseRevOf(issueId),
      changes,
      message
    });
    void flushWhenOnline();
  };

  const createIssue = (values: IssueForm) => {
    const issueId = uid('issue');
    const at = new Date().toISOString();
    const fields: AuditIssue['fields'] = {};
    for (const key of EDITABLE_FIELDS) {
      if (key === 'status') continue;
      const value =
        key === 'title'
          ? values.title
          : key === 'flow'
            ? values.flow
            : key === 'steps'
              ? values.steps
              : key === 'impactGroup'
                ? values.impactGroup
                : key === 'severity'
                  ? values.severity
                  : '';
      fields[key] = { value, rev: 0, authorId: activeAuthor(), at };
    }
    fields.status = { value: 'open', rev: 0, authorId: activeAuthor(), at };
    enqueue({ opId: uid('op'), type: 'create', issueId, at, authorId: activeAuthor(), fields });
    setSelectedId(issueId);
    void flushWhenOnline();
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonicalId = mergeInto();
    if (!duplicate || !canonicalId || duplicate.id === canonicalId) return;
    enqueue({
      opId: uid('op'),
      type: 'merge',
      duplicateId: duplicate.id,
      canonicalId,
      at: new Date().toISOString(),
      authorId: activeAuthor(),
      baseRev: baseRevOf(duplicate.id)
    });
    setMergeInto('');
    void flushWhenOnline();
  };

  const resolveConflict = (issueId: string, field: IssueField, choice: { kind: 'keep-current' } | { kind: 'version'; version: FieldVersion }) => {
    enqueue({
      opId: uid('op'),
      type: 'resolve',
      issueId,
      at: new Date().toISOString(),
      authorId: activeAuthor(),
      field,
      choice
    });
    void flushWhenOnline();
  };

  // --- 网络恢复：按批次顺序推送，失败保留批次与进度，可重试；成功则刷新快照 ---
  const flush = () =>
    new Promise<void>((resolveFlush) => {
      if (syncing()) {
        resolveFlush();
        return;
      }
      setSyncing(true);
      window.setTimeout(() => {
        // 在工作副本上事务式推演：任何一步抛错都只影响工作副本。
        const workServer = JSON.parse(JSON.stringify(server)) as ServerState;
        const workReplica = JSON.parse(JSON.stringify(replica)) as Replica;
        // 本次先把上一次失败的批次重置为 queued，让它们重新参与推送。
        let attemptedOps = 0;
        try {
          const willFail = consumeFailNext();
          for (const batch of workReplica.outbox) {
            if (batch.status !== 'queued' && batch.status !== 'failed') continue;
            batch.status = 'queued';
            const start = batch.appliedCount;
            // 已写入的操作靠 opId 幂等跳过，时间线不会重复追加。
            const failOpId = willFail && attemptedOps === 0 ? batch.ops[start]?.opId : undefined;
            try {
              pushBatch(workServer, batch, failOpId);
              attemptedOps += batch.ops.length - start;
            } catch (error) {
              attemptedOps += batch.appliedCount - start;
              throw error;
            }
          }
          // 全部批次成功：压缩已完成批次，快照更新到共同记录（续作接着新修订号走）。
          workReplica.outbox = workReplica.outbox.filter((batch) => batch.status === 'failed');
          workReplica.snapshot = workServer;
          setServer(reconcile(workServer));
          setReplica(reconcile(workReplica));
          if (attemptedOps > 0) flash('ok', `同步完成：${attemptedOps} 条修改已按字段对账写入共同记录`);
        } catch (error) {
          // 停在第一个失败批次：之前批次与失败批次的已写入前缀都进了 workServer。
          // 快照前移到共同记录，失败批次（含 appliedCount）原样保留，重试时幂等续推。
          workReplica.snapshot = workServer;
          const failed = workReplica.outbox.find((batch) => batch.status === 'failed');
          setServer(reconcile(workServer));
          setReplica(reconcile(workReplica));
          flash(
            'error',
            `合并失败，离线批次已保留可重试${attemptedOps > 0 ? `（本次已先写入 ${attemptedOps} 条，不会重复追加）` : ''}：${
              failed?.lastError ?? (error instanceof Error ? error.message : String(error))
            }`
          );
        } finally {
          setSyncing(false);
          resolveFlush();
        }
      }, 180);
    });

  const flushWhenOnline = () => {
    if (online() && !syncing()) void flush();
  };

  // 联机时操作入队后自动推送
  createEffect(() => {
    pendingOpsCount();
    online();
    if (online()) void flush();
  });

  const switchAuthor = (authorId: string) => {
    setActiveAuthor(authorId);
    setReplica(reconcile(loadReplica(authorId, server as ServerState)));
    setMergeInto('');
  };

  const toggleNetwork = () => {
    const next = !online();
    setOnline(next);
    if (next) void flush();
  };

  const resetDemo = () => {
    const fresh = resetAll(server as ServerState);
    setServer(reconcile(fresh));
    setReplica(reconcile({ authorId: activeAuthor(), snapshot: JSON.parse(JSON.stringify(fresh)) as ServerState, outbox: [] }));
    saveReplica({ authorId: activeAuthor(), snapshot: JSON.parse(JSON.stringify(fresh)) as ServerState, outbox: [] });
    const first = canonicalIssues(fresh)[0];
    setSelectedId(first?.id ?? '');
    flash('ok', '演示数据已重置');
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

  const statusActions: { label: string; patch: Partial<Record<IssueField, string>>; message: string }[] = [
    { label: '确认问题', patch: { status: 'triaged' }, message: '审核员完成分诊' },
    { label: '开始修复', patch: { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, message: '开发人员开始修复' },
    { label: '提交复测', patch: { status: 'verifying' }, message: '开发人员提交修复，进入复测' },
    { label: '复测通过', patch: { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, message: '复测通过并关闭问题' },
    { label: '复测失败', patch: { status: 'reopened', retestNote: '焦点顺序仍不正确' }, message: '复测失败并重新打开' }
  ];

  const pendingBadgeFor = (batchId: string) => {
    if (!batchId) return '';
    const found = replica.outbox
      .filter((batch) => batch.status === 'queued' || batch.status === 'failed')
      .find((batch) => batch.id === batchId);
    if (!found) return '';
    return found.status === 'failed' ? '同步失败·待重试' : '待同步';
  };

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作 · 修订号 r{server.clock}</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 字段级修订对账，离线批次可续作；快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p>
          </div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="card syncbar" aria-label="协作与网络状态">
          <div class="sync-row">
            <label>当前审核员
              <select value={activeAuthor()} onChange={(event) => switchAuthor(event.currentTarget.value)}>
                <For each={Object.entries(AUTHORS)}>{([id, info]) => <option value={id}>{info.name}（{id}）</option>}</For>
              </select>
            </label>
            <span class={`status-dot ${online() ? 'on' : 'off'}`} aria-hidden="true" />
            <strong>{online() ? '联机中' : '离线中'}</strong>
            <button onClick={toggleNetwork}>{online() ? '模拟断网' : '网络已恢复'}</button>
            <button class="secondary" onClick={() => void flush()} disabled={online() === false || pendingOpsCount() === 0 || syncing()}>
              {syncing() ? '同步中…' : `立即同步（${pendingOpsCount()} 条待发）`}
            </button>
            <button class="secondary" onClick={() => armFailNext()} title="让下一次推送在服务端失败一次，用于演示失败保留与重试">注入一次同步故障</button>
            <button class="secondary danger-text" onClick={resetDemo}>重置演示数据</button>
          </div>
          <Show when={notice()} keyed>
            {(item) => <p class={item.kind === 'ok' ? 'notice ok' : 'notice error'} role="status">{item.text}</p>}
          </Show>
          <Show when={failedBatches().length > 0}>
            <div class="failed-box" role="alert">
              <strong>{failedBatches().length} 个离线批次合并失败，已保留在本地：</strong>
              <For each={failedBatches()}>
                {(batch) => (
                  <div class="batch-line">
                    <span>批次 {batch.id.slice(-6)} · 进度 {batch.appliedCount}/{batch.ops.length} · {batch.lastError}</span>
                    <button class="secondary" onClick={() => void flush()} disabled={!online()}>网络恢复后重试</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={conflictIssues().length > 0}>
            <p class="notice warn" role="status">
              {conflictIssues().length} 条问题存在同字段多人修改，两版均已保留，等待审核员裁决：
              <For each={conflictIssues()}>
                {(issue, index) => (
                  <>
                    {index() > 0 ? '；' : ' '}
                    <button class="link-button" onClick={() => setSelectedId(resolveId(view(), issue.id))}>
                      {fieldValue(issue, 'title')}（{pendingCount(issue)} 版待审）
                    </button>
                  </>
                )}
              </For>
            </p>
          </Show>
        </section>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{canonicalIssues(view()).length}</strong></div>
          <div class="card"><span>待修复</span><strong>{canonicalIssues(view()).filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(fieldValue(issue, 'status') as IssueStatus)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{canonicalIssues(view()).filter((issue) => fieldValue(issue, 'status') === 'verifying').length}</strong></div>
          <div class="card"><span>冲突待裁决</span><strong>{conflictIssues().reduce((sum, issue) => sum + pendingCount(issue), 0)}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{online() ? '同步正常' : `离线排队 ${pendingOpsCount()} 条`}</small></h2>
            <For each={viewIssues()}>
              {(issue) => {
                const canonicalId = () => resolveId(view(), issue.id);
                const isDuplicate = () => issue.canonicalId !== undefined;
                return (
                  <article class="issue" style={selected()?.id === canonicalId() || selectedId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                    <h3>
                      <button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selected()?.id === canonicalId() ? 'true' : undefined}>
                        {fieldValue(issue, 'title')}
                      </button>
                    </h3>
                    <div class="meta">
                      <span class="badge">r{issue.rev}</span>
                      <span class="badge">{STATUS_LABELS[fieldValue(issue, 'status') as IssueStatus] ?? fieldValue(issue, 'status')}</span>
                      <span class="badge">{fieldValue(issue, 'severity')}</span>
                      <span>{fieldValue(issue, 'flow')}</span>
                      <Show when={isDuplicate()}><span class="badge warn-badge">重复项→主记录</span></Show>
                      <Show when={hasPendingConflicts(issue)}><span class="badge danger-badge">{pendingCount(issue)} 版冲突待审</span></Show>
                    </div>
                  </article>
                );
              }}
            </For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>} keyed>
              {(issue) => {
                const canonicalId = () => resolveId(view(), issue.id);
                const mergeTargets = () => canonicalIssues(view()).filter((item) => item.id !== canonicalId());
                return (
                  <>
                    <Show when={issue.id !== canonicalId() || selectedIsAlias()}>
                      <p class="notice warn" role="status">
                        这是已合并的重复项（旧链接），主问题、时间线都指向主记录：
                        <button class="link-button" onClick={() => setSelectedId(canonicalId())}>前往主问题「{fieldValue(getIssue(view(), canonicalId())!, 'title')}」</button>
                      </p>
                    </Show>
                    <h3>{fieldValue(issue, 'title')} <small class="rev-tag">修订 r{issue.rev}</small></h3>
                    <p><strong>复现步骤：</strong>{fieldValue(issue, 'steps') || '尚未填写'}</p>
                    <p><strong>修复记录：</strong>{fieldValue(issue, 'fixNote') || '尚未填写'}</p>
                    <p><strong>复测记录：</strong>{fieldValue(issue, 'retestNote') || '尚未填写'}</p>

                    <FieldConflicts issue={issue} onResolve={resolveConflict} />

                    <div role="group" aria-label="问题状态操作">
                      <For each={statusActions}>
                        {(action) => (
                          <button
                            class={action.label === '复测失败' ? 'danger' : ''}
                            onClick={() => editIssue(canonicalId(), action.patch, action.message)}
                          >
                            {action.label}
                          </button>
                        )}
                      </For>
                    </div>
                    <hr />
                    <FieldEditor issueId={canonicalId()} currentRev={issue.rev} onSave={(values) => editIssue(canonicalId(), values)} />
                    <hr />
                    <label>合并到主问题
                      <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                        <option value="">选择问题</option>
                        <For each={mergeTargets()}>{(item) => <option value={item.id}>{fieldValue(item, 'title')}（r{item.rev}）</option>}</For>
                      </select>
                    </label>
                    <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
                    <p class="hint">合并后旧记录成为别名：旧链接、时间线与后续修改都会落到同一主记录。</p>
                  </>
                );
              }}
            </Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => setFieldValue(field, event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => setFieldValue(field, event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="steps">{(field, props) => <label>复现步骤<textarea {...props} rows="4" value={field.value} onInput={(event) => setFieldValue(field, event.currentTarget.value)} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field) => <label>影响人群<select value={field.value} onChange={(event) => setFieldValue(field, event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field) => <label>严重程度<select value={field.value} onChange={(event) => setFieldValue(field, event.currentTarget.value as Severity)}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <button type="submit">创建问题（离线时进入本地批次）</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List>
                <Tabs.Trigger value="activity">操作时间线</Tabs.Trigger>
                <Tabs.Trigger value="batches">离线批次（{replica.outbox.length}）</Tabs.Trigger>
                <Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="activity">
                <Show when={selected()} fallback={<p>暂无问题。</p>} keyed>
                  {(issue) => {
                    const events = createMemo(() => eventsForIssue(view(), issue.id));
                    return (
                      <div class="timeline" aria-live="polite">
                        <For each={events().slice(0, 16)}>
                          {(event) => (
                            <div style="margin-bottom:12px">
                              <strong>{new Date(event.at).toLocaleString()}</strong>
                              <div>
                                {authorName(event.authorId)}：{event.message}
                                <Show when={pendingBadgeFor(event.batchId ?? '')}>
                                  {' '}<span class="badge warn-badge">本地批次 · {pendingBadgeFor(event.batchId ?? '')}</span>
                                </Show>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    );
                  }}
                </Show>
              </Tabs.Content>
              <Tabs.Content value="batches">
                <Show when={replica.outbox.length > 0} fallback={<p>没有排队中的离线批次。</p>}>
                  <ul class="batch-list">
                    <For each={[...replica.outbox].reverse()}>
                      {(batch: OutboxBatch) => (
                        <li>
                          <strong>批次 …{batch.id.slice(-6)}</strong>
                          <span class={`badge ${batch.status === 'failed' ? 'danger-badge' : batch.status === 'applied' ? '' : 'warn-badge'}`}>
                            {batch.status === 'failed' ? '失败待重试' : batch.status === 'applied' ? '已同步' : batch.open ? '离线收集中' : '排队中'}
                          </span>
                          <span>{new Date(batch.createdAt).toLocaleString()} · {batch.ops.length} 个操作 · 已写入 {batch.appliedCount}</span>
                          <Show when={batch.lastError}><em class="error">{batch.lastError}</em></Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Tabs.Content>
              <Tabs.Content value="keyboard">
                <ul>
                  <li><kbd>N</kbd>：聚焦新建问题标题</li>
                  <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li>
                  <li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li>
                  <li>同字段多人修改时两版并存，必须由审核员显式裁决，不会自动覆盖。</li>
                </ul>
              </Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

/** 同字段两版/多版的裁决面板。 */
function FieldConflicts(props: {
  issue: AuditIssue;
  onResolve: (issueId: string, field: IssueField, choice: { kind: 'keep-current' } | { kind: 'version'; version: FieldVersion }) => void;
}) {
  const fields = createMemo(() =>
    (Object.keys(props.issue.pending) as IssueField[]).filter((field) => (props.issue.pending[field]?.length ?? 0) > 0)
  );
  return (
    <Show when={fields().length > 0}>
      <div class="conflict-box" role="group" aria-label="字段冲突裁决">
        <h4>同字段多人修改 · 两版均保留，等待裁决</h4>
        <For each={fields()}>
          {(field) => {
            const current = () => props.issue.fields[field];
            return (
              <fieldset class="conflict-field">
                <legend>{FIELD_LABELS[field]}（r{current()?.rev ?? 0}）</legend>
                <div class="conflict-version current">
                  <label>
                    <input
                      type="radio"
                      name={`conflict-${props.issue.id}-${field}`}
                      checked
                      onChange={() => props.onResolve(props.issue.id, field, { kind: 'keep-current' })}
                    />
                    <strong>当前版本</strong> · {authorName(current()?.authorId ?? '')} · {new Date(current()?.at ?? '').toLocaleString()}
                    <pre>{current()?.value}</pre>
                  </label>
                </div>
                <For each={props.issue.pending[field] ?? []}>
                  {(version) => (
                    <div class="conflict-version">
                      <label>
                        <input
                          type="radio"
                          name={`conflict-${props.issue.id}-${field}`}
                          onChange={() => props.onResolve(props.issue.id, field, { kind: 'version', version })}
                        />
                        <strong>待审版本</strong> · {authorName(version.authorId)} · {new Date(version.at).toLocaleString()}
                        <pre>{version.value}</pre>
                      </label>
                    </div>
                  )}
                </For>
              </fieldset>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** 字段编辑：每个输入按“原记录修订号”入队，不覆盖其他人的字段。 */
function FieldEditor(props: { issueId: string; currentRev: number; onSave: (values: Partial<Record<IssueField, string>>) => void }) {
  const [draft, setDraft] = createStore<Partial<Record<IssueField, string>>>({});
  const set = (field: IssueField, value: string) => setDraft(produce((d) => void (d[field] = value)));
  const submit = () => {
    const values: Partial<Record<IssueField, string>> = {};
    for (const key of EDITABLE_FIELDS) {
      if (draft[key] !== undefined && draft[key] !== '') values[key] = draft[key];
    }
    if (Object.keys(values).length > 0) props.onSave(values);
    setDraft(reconcile({}));
  };
  return (
    <div class="field-editor">
      <h4>补充字段（基于修订 r{props.currentRev}，只提交填写过的字段）</h4>
      <label>问题标题<input value={draft.title ?? ''} onInput={(e) => set('title', e.currentTarget.value)} placeholder="修改标题" /></label>
      <label>修复记录<textarea rows="2" value={draft.fixNote ?? ''} onInput={(e) => set('fixNote', e.currentTarget.value)} placeholder="填写修复说明" /></label>
      <label>复测记录<textarea rows="2" value={draft.retestNote ?? ''} onInput={(e) => set('retestNote', e.currentTarget.value)} placeholder="填写复测结论" /></label>
      <button type="button" class="secondary" onClick={submit}>提交字段修改</button>
    </div>
  );
}
