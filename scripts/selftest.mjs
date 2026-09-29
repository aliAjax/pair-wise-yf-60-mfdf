import assert from 'node:assert/strict';
import * as C from '../src/lib/collab.ts';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const fv = (value, authorId, at) => ({ value, rev: 0, authorId, at });
const makeIssue = (server, id, authorId, values = {}) => {
  const fields = { title: fv(`问题-${id}`, authorId, '2026-09-29T08:00:00Z'), ...{} };
  for (const [k, v] of Object.entries(values)) fields[k] = fv(v, authorId, '2026-09-29T08:00:00Z');
  server.issues[id] = { id, rev: 0, createdAt: '2026-09-29T08:00:00Z', createdBy: authorId, fields, pending: {} };
  return server.issues[id];
};

// 1. 修订号：每次修改递增，且字段版本记录写入时的修订号
test('每条修改带修订号，字段版本记录写入修订', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  const issue = server.issues['issue-1'];
  assert.equal(issue.rev, 0);
  C.applyOperation(server, {
    opId: 'op-1', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0,
    changes: [{ field: 'status', value: 'fixing', label: '问题状态' }]
  });
  assert.equal(server.issues['issue-1'].rev, 1);
  assert.equal(server.issues['issue-1'].fields.status.rev, 1);
  C.applyOperation(server, {
    opId: 'op-2', type: 'edit', issueId: 'issue-1', at: '2026-09-29T10:00:00Z', authorId: 'auditor-a', baseRev: 1,
    changes: [{ field: 'fixNote', value: '修复 v1', label: '修复记录' }]
  });
  assert.equal(server.issues['issue-1'].rev, 2);
  assert.equal(server.issues['issue-1'].fields.status.rev, 1, '早先字段保留在自己修订号');
});

// 2. 同一字段不同人修改：保留两版待审核，不整条覆盖
test('同一字段两人离线修改 → 保留两版待审核，不覆盖', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  // 甲先同步（baseRev 0）
  C.applyOperation(server, {
    opId: 'op-a', type: 'edit', issueId: 'issue-2', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0,
    changes: [{ field: 'fixNote', value: '甲：修复方案 A', label: '修复记录' }]
  });
  assert.equal(server.issues['issue-2'].rev, 1);
  // 乙也基于原记录 rev0 离线修改同字段
  const out = C.applyOperation(server, {
    opId: 'op-b', type: 'edit', issueId: 'issue-2', at: '2026-09-29T10:00:00Z', authorId: 'auditor-b', baseRev: 0,
    changes: [{ field: 'fixNote', value: '乙：修复方案 B', label: '修复记录' }]
  });
  assert.deepEqual(out.conflicts, ['fixNote']);
  assert.equal(C.fieldValue(server.issues['issue-2'], 'fixNote'), '甲：修复方案 A', '当前值不能被后到内容覆盖');
  assert.equal(server.issues['issue-2'].pending.fixNote.length, 1);
  assert.equal(server.issues['issue-2'].pending.fixNote[0].value, '乙：修复方案 B', '第二版保留待审核');
  // 不同字段不受影响，各自生效
  C.applyOperation(server, {
    opId: 'op-c', type: 'edit', issueId: 'issue-2', at: '2026-09-29T11:00:00Z', authorId: 'auditor-c', baseRev: 0,
    changes: [{ field: 'severity', value: 'critical', label: '严重程度' }]
  });
  assert.equal(C.fieldValue(server.issues['issue-2'], 'severity'), 'critical');
  assert.ok(!server.issues['issue-2'].pending.severity);
});

// 3. 冲突裁决：采纳另一版本后 pending 清空，写 resolve 时间线
test('审核员裁决冲突后只保留一版', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  C.applyOperation(server, { opId: 'op-a', type: 'edit', issueId: 'issue-2', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0, changes: [{ field: 'fixNote', value: '甲版' }] });
  C.applyOperation(server, { opId: 'op-b', type: 'edit', issueId: 'issue-2', at: '2026-09-29T10:00:00Z', authorId: 'auditor-b', baseRev: 0, changes: [{ field: 'fixNote', value: '乙版' }] });
  const before = server.events.length;
  const pendingVersion = server.issues['issue-2'].pending.fixNote[0];
  C.applyOperation(server, {
    opId: 'op-r', type: 'resolve', issueId: 'issue-2', at: '2026-09-29T12:00:00Z', authorId: 'auditor-c',
    field: 'fixNote', choice: { kind: 'version', version: pendingVersion }
  });
  assert.equal(C.fieldValue(server.issues['issue-2'], 'fixNote'), '乙版');
  assert.ok(!server.issues['issue-2'].pending.fixNote);
  assert.equal(server.events.length, before + 1);
});

// 4. 离线批次：按原记录排队；同字段连续修改合并为一条
test('离线批次携带 baseRev 排队，同字段续作就地合并', () => {
  const seed = C.createSeedServer('2026-09-29T08:00:00Z');
  const replica = { authorId: 'auditor-b', snapshot: C.cloneServer(seed), outbox: [] };
  const edit1 = { opId: 'b1', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-b', baseRev: 0, changes: [{ field: 'fixNote', value: '离线第一版', label: '修复记录' }] };
  const edit2 = { opId: 'b2', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:10:00Z', authorId: 'auditor-b', baseRev: 0, changes: [{ field: 'fixNote', value: '离线第二版', label: '修复记录' }, { field: 'status', value: 'verifying', label: '问题状态' }] };
  C.queueOperation(replica, edit1, false);
  const batch = C.queueOperation(replica, edit2, false);
  assert.equal(replica.outbox.length, 1);
  assert.equal(batch.ops.length, 1, '同 baseRev 的编辑合并');
  assert.equal(batch.ops[0].changes.length, 2);
  assert.equal(batch.ops[0].changes.find((c) => c.field === 'fixNote').value, '离线第二版');
  assert.equal(batch.open, true);
  assert.equal(batch.ops[0].baseRev, 0, '仍按原记录修订号对账');
});

// 5. 合并失败：批次保留可重试，已写入修改不重复追加时间线
test('推送中途失败 → 批次保留、appliedCount 记录进度、重试幂等', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  const batch = {
    id: 'batch-x', authorId: 'auditor-a', createdAt: '2026-09-29T09:00:00Z', status: 'queued', open: true, ops: [], appliedCount: 0
  };
  batch.ops.push({ opId: 'x1', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0, changes: [{ field: 'status', value: 'fixing', label: '问题状态' }] });
  batch.ops.push({ opId: 'x2', type: 'merge', duplicateId: 'issue-2', canonicalId: 'missing-issue', at: '2026-09-29T09:05:00Z', authorId: 'auditor-a', baseRev: 0 });
  assert.throws(() => C.pushBatch(server, batch), /主问题/);
  assert.equal(batch.status, 'failed');
  assert.equal(batch.appliedCount, 1, '第一个操作已写入');
  assert.ok(batch.lastError);
  const eventsAfterFirst = server.events.length;
  const revAfterFirst = server.issues['issue-1'].rev;
  // 修好合并目标后原样重试
  makeIssue(server, 'missing-issue', 'auditor-a', { title: '后补主问题' });
  C.pushBatch(server, batch);
  assert.equal(server.issues['issue-1'].rev, revAfterFirst, '已写入的编辑重试时不再修改记录');
  assert.equal(server.events.length, eventsAfterFirst + 2, '编辑时间线不重复，仅补两条 merge 事件');
  assert.equal(batch.status, 'applied');
  assert.equal(batch.appliedCount, 2);
});

// 6. opId 幂等：重复投递完全不产生副作用
test('相同 opId 重放不重复追加时间线', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  const op = { opId: 'dup-op', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0, changes: [{ field: 'status', value: 'closed', label: '问题状态' }] };
  C.applyOperation(server, op);
  const events = server.events.length;
  const rev = server.issues['issue-1'].rev;
  const out = C.applyOperation(server, op);
  assert.equal(out.noop, true);
  assert.equal(server.events.length, events);
  assert.equal(server.issues['issue-1'].rev, rev);
});

// 7. 重复合并：主问题、时间线、旧链接全部指到主记录
test('合并后 resolveId/时间线/旧链接都指向主记录', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  C.applyOperation(server, { opId: 'm1', type: 'merge', duplicateId: 'issue-2', canonicalId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0 });
  assert.equal(server.issues['issue-2'].canonicalId, 'issue-1');
  assert.equal(C.resolveId(server, 'issue-2'), 'issue-1', '旧链接解析到主记录');
  const resolved = C.getIssue(server, 'issue-2');
  assert.equal(resolved.id, 'issue-1');
  // 合并后对旧链接做编辑，实际落到主记录
  C.applyOperation(server, { opId: 'm2', type: 'edit', issueId: 'issue-2', at: '2026-09-29T10:00:00Z', authorId: 'auditor-b', baseRev: 0, changes: [{ field: 'fixNote', value: '通过旧链接补充', label: '修复记录' }] });
  assert.equal(C.fieldValue(server.issues['issue-1'], 'fixNote'), '通过旧链接补充');
  // 时间线：主问题视图包含重复项的全部历史
  const ids = C.eventsForIssue(server, 'issue-1').map((e) => e.message);
  assert.ok(ids.some((m) => m.includes('重复问题已合并')));
  const viaOld = C.eventsForIssue(server, 'issue-2');
  assert.equal(viaOld.length, C.eventsForIssue(server, 'issue-1').length, '旧链接看到同一时间线');
});

// 8. 已合并记录不能再合并到别的主问题（可重试失败路径）
test('重复项二次合并到不同主问题 → 失败，批次可保留', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  makeIssue(server, 'issue-3', 'auditor-c', { title: '另一个候选主问题' });
  C.applyOperation(server, { opId: 'm1', type: 'merge', duplicateId: 'issue-2', canonicalId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0 });
  const out = C.applyOperation(server, { opId: 'm3', type: 'merge', duplicateId: 'issue-2', canonicalId: 'issue-3', at: '2026-09-29T10:00:00Z', authorId: 'auditor-a', baseRev: 0 });
  assert.ok(out.error);
});

// 9. deriveView：离线视图叠加本地未同步操作
test('deriveView 叠加未同步批次且不改快照', () => {
  const seed = C.createSeedServer('2026-09-29T08:00:00Z');
  const replica = { authorId: 'auditor-b', snapshot: C.cloneServer(seed), outbox: [] };
  C.queueOperation(replica, { opId: 'l1', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-b', baseRev: 0, changes: [{ field: 'fixNote', value: '离线可见', label: '修复记录' }] }, false);
  const view = C.deriveView(replica);
  assert.equal(C.fieldValue(C.getIssue(view, 'issue-1'), 'fixNote'), '离线可见');
  assert.equal(C.fieldValue(C.getIssue(replica.snapshot, 'issue-1'), 'fixNote'), '', '快照不被污染');
});

// 10. 两人同字段+一人改另一字段的混合批次按字段对账，绝不整条覆盖
test('混合批次字段级对账，后到批次不覆盖别人的其他字段', () => {
  const server = C.createSeedServer('2026-09-29T08:00:00Z');
  // 甲批次：改 fixNote + status
  C.applyOperation(server, {
    opId: 'a-multi', type: 'edit', issueId: 'issue-1', at: '2026-09-29T09:00:00Z', authorId: 'auditor-a', baseRev: 0,
    changes: [{ field: 'fixNote', value: '甲修复', label: '修复记录' }, { field: 'status', value: 'closed', label: '问题状态' }]
  });
  // 乙批次（基于原记录）：改 fixNote + retestNote
  const out = C.applyOperation(server, {
    opId: 'b-multi', type: 'edit', issueId: 'issue-1', at: '2026-09-29T10:00:00Z', authorId: 'auditor-b', baseRev: 0,
    changes: [{ field: 'fixNote', value: '乙修复', label: '修复记录' }, { field: 'retestNote', value: '乙复测', label: '复测记录' }]
  });
  assert.deepEqual(out.conflicts, ['fixNote']);
  assert.equal(C.fieldValue(server.issues['issue-1'], 'fixNote'), '甲修复');
  assert.equal(C.fieldValue(server.issues['issue-1'], 'status'), 'closed', '甲的状态保留');
  assert.equal(C.fieldValue(server.issues['issue-1'], 'retestNote'), '乙复测', '乙的其他字段正常生效');
});

console.log(`\n${passed} 项协作引擎自测全部通过`);
