import assert from 'node:assert/strict';
import * as C from '../src/lib/collab.ts';

/**
 * 端到端：模拟 index.tsx 的协作编排（不含 UI），验证完整需求链路。
 * 三个审核员各持一个 Replica + 共享 ServerState：
 * 1. 乙、丙离线基于同一原记录改同一字段；
 * 2. 甲在线先推；乙恢复网络后产生字段冲突、两版保留；
 * 3. 丙的批次推送时合并失败 → 批次保留、重试幂等；
 * 4. 审核员裁决冲突；
 * 5. 重复合并后旧链接、时间线全部指向主记录。
 */

const at = (min: number) => new Date(Date.parse('2026-09-29T08:00:00Z') + min * 60_000).toISOString();
let n = 0;
const opId = () => `e2e-op-${++n}`;

const server = C.createSeedServer(at(0));

// 三个副本，快照都停在共同记录 r0
const mkReplica = (authorId: string): C.Replica => ({ authorId, snapshot: C.cloneServer(server), outbox: [] });
const A = mkReplica('auditor-a');
const B = mkReplica('auditor-b');
const D = mkReplica('auditor-c');

// --- 离线：乙改 issue-1 的修复记录+状态；丙也改修复记录（同字段）---
C.queueOperation(A, {
  opId: opId(), type: 'edit', issueId: 'issue-1', at: at(5), authorId: 'auditor-a', baseRev: 0,
  changes: [{ field: 'fixNote', value: '甲在线修复', label: '修复记录' }]
}, true);
C.queueOperation(B, {
  opId: opId(), type: 'edit', issueId: 'issue-1', at: at(10), authorId: 'auditor-b', baseRev: 0,
  changes: [{ field: 'fixNote', value: '乙离线修复', label: '修复记录' }, { field: 'status', value: 'fixing', label: '问题状态' }]
}, false);
C.queueOperation(D, {
  opId: opId(), type: 'edit', issueId: 'issue-1', at: at(12), authorId: 'auditor-c', baseRev: 0,
  changes: [{ field: 'fixNote', value: '丙离线修复', label: '修复记录' }]
}, false);
// 丙还离线做了一次重复合并：issue-2 → issue-1
C.queueOperation(D, {
  opId: opId(), type: 'merge', duplicateId: 'issue-2', canonicalId: 'issue-1', at: at(13), authorId: 'auditor-c', baseRev: 0
}, false);

assert.equal(B.outbox.length, 1);
assert.equal(D.outbox.length, 1);
assert.equal(D.outbox[0].ops.length, 2, '丙的编辑与合并在同一离线批次排队');

// 离线视图能看到自己的续作
assert.equal(C.fieldValue(C.getIssue(C.deriveView(B), 'issue-1'), 'fixNote'), '乙离线修复');
assert.equal(C.fieldValue(C.getIssue(B.snapshot, 'issue-1'), 'fixNote'), '', '共同记录快照未被污染');

// --- 甲的在线批次推送成功 ---
for (const batch of A.outbox) C.pushBatch(server, batch);
A.snapshot = C.cloneServer(server);
A.outbox = A.outbox.filter((b) => b.status === 'failed');
assert.equal(C.fieldValue(server.issues['issue-1'], 'fixNote'), '甲在线修复');

// --- 乙恢复网络：同字段冲突保留两版，status 字段正常生效（不整条覆盖）---
for (const batch of B.outbox) C.pushBatch(server, batch);
B.snapshot = C.cloneServer(server);
const i1 = server.issues['issue-1'];
assert.equal(C.fieldValue(i1, 'fixNote'), '甲在线修复', '后到内容不能整条覆盖甲的值');
assert.equal(i1.pending.fixNote?.length, 1);
assert.equal(i1.pending.fixNote[0].value, '乙离线修复');
assert.equal(C.fieldValue(i1, 'status'), 'fixing', '乙的其他字段按字段级对账生效');

// --- 丙的批次：编辑产生第二个待审版本；随后的合并制造一次失败后重试 ---
// 先让合并指向一个不存在的主问题来触发失败（保持原 issue-1 合并在重试时成功）：
const mergeOp = D.outbox[0].ops[1];
assert.equal(mergeOp.type, 'merge');
(mergeOp as { canonicalId: string }).canonicalId = 'issue-ghost';
assert.throws(() => C.pushBatch(server, D.outbox[0]));
assert.equal(D.outbox[0].status, 'failed');
assert.equal(D.outbox[0].appliedCount, 1, '编辑已写入，合并失败，批次保留');
const eventsBeforeRetry = server.events.length;
assert.ok(i1.pending.fixNote.some((v) => v.value === '丙离线修复'), '丙版本也保留待审');
assert.equal(i1.pending.fixNote.length, 2, '甲当前 + 乙、丙两版待审');

// 网络恢复，修正目标后重试原批次：编辑幂等跳过、时间线不重复
(mergeOp as { canonicalId: string }).canonicalId = 'issue-1';
C.pushBatch(server, D.outbox[0]);
assert.equal(D.outbox[0].status, 'applied');
assert.equal(server.events.length, eventsBeforeRetry + 2, '仅补合并的两条时间线，编辑未重复追加');

// --- 合并效果：issue-2 旧链接、时间线都到 issue-1 ---
assert.equal(C.resolveId(server, 'issue-2'), 'issue-1');
assert.equal(C.getIssue(server, 'issue-2')?.id, 'issue-1');
const timelineCanonical = C.eventsForIssue(server, 'issue-1');
const timelineViaOldLink = C.eventsForIssue(server, 'issue-2');
assert.equal(timelineViaOldLink.length, timelineCanonical.length, '旧链接看到同一条合并时间线');

// --- 审核员（甲）裁决：采纳丙的版本 ---
const chosen = i1.pending.fixNote.find((v) => v.value === '丙离线修复')!;
C.applyOperation(server, {
  opId: opId(), type: 'resolve', issueId: 'issue-1', at: at(30), authorId: 'auditor-a',
  field: 'fixNote', choice: { kind: 'version', version: chosen }
});
assert.equal(C.fieldValue(i1, 'fixNote'), '丙离线修复');
assert.ok(!i1.pending.fixNote, '裁决后只留一版');
// 乙版本仍被驳回，不存在覆盖残留
assert.ok(C.fieldValue(i1, 'status') === 'fixing', '乙生效过的其他字段不受裁决影响');

// --- 再次推送相同 op（模拟重复投递）：时间线零增长 ---
const eventsFinal = server.events.length;
C.applyOperation(server, {
  opId: 'DUP', type: 'edit', issueId: 'issue-1', at: at(31), authorId: 'auditor-a', baseRev: 0,
  changes: [{ field: 'retestNote', value: 'X', label: '复测记录' }]
});
C.applyOperation(server, {
  opId: 'DUP', type: 'edit', issueId: 'issue-1', at: at(31), authorId: 'auditor-a', baseRev: 0,
  changes: [{ field: 'retestNote', value: 'X', label: '复测记录' }]
});
assert.equal(server.events.length, eventsFinal + 1, '重复 opId 只产生一次时间线');

console.log('端到端协作流程自测通过：修订号 → 离线排队 → 字段冲突两版保留 → 失败批次重试幂等 → 裁决 → 重复合并归并');
