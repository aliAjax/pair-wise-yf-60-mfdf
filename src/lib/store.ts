import type { Replica, ServerState } from './collab';
import { cloneServer, createSeedServer } from './collab';

const SERVER_KEY = 'a11y-audit-cm-server-v2';
const REPLICA_KEY = (authorId: string) => `a11y-audit-cm-replica-v2:${authorId}`;
const ACTIVE_AUTHOR_KEY = 'a11y-audit-cm-active-author-v2';
const ONLINE_KEY = 'a11y-audit-cm-online-v2';
const FAIL_NEXT_KEY = 'a11y-audit-cm-fail-next-v2';

// SSR 阶段没有 localStorage，所有访问统一走这两个守卫。
const getItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
};
const setItem = (key: string, value: string): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, value);
};
const removeItem = (key: string): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(key);
};

export function loadServer(): ServerState {
  const raw = getItem(SERVER_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as ServerState;
    } catch {
      // 落到种子数据
    }
  }
  const seed = createSeedServer();
  setItem(SERVER_KEY, JSON.stringify(seed));
  return seed;
}

export function saveServer(server: ServerState): void {
  setItem(SERVER_KEY, JSON.stringify(server));
}

export function loadReplica(authorId: string, server: ServerState): Replica {
  const raw = getItem(REPLICA_KEY(authorId));
  if (raw) {
    try {
      return JSON.parse(raw) as Replica;
    } catch {
      // 落到新副本
    }
  }
  const replica: Replica = { authorId, snapshot: cloneServer(server), outbox: [] };
  saveReplica(replica);
  return replica;
}

export function saveReplica(replica: Replica): void {
  setItem(REPLICA_KEY(replica.authorId), JSON.stringify(replica));
}

export function loadActiveAuthor(): string {
  return getItem(ACTIVE_AUTHOR_KEY) ?? 'auditor-a';
}
export function saveActiveAuthor(authorId: string): void {
  setItem(ACTIVE_AUTHOR_KEY, authorId);
}

export function loadOnline(): boolean {
  return getItem(ONLINE_KEY) !== 'off';
}
export function saveOnline(online: boolean): void {
  setItem(ONLINE_KEY, online ? 'on' : 'off');
}

/** 下一次推送是否注入一次“服务端暂时不可用”故障（用于演示失败保留与重试）。 */
export function consumeFailNext(): boolean {
  if (getItem(FAIL_NEXT_KEY) === '1') {
    removeItem(FAIL_NEXT_KEY);
    return true;
  }
  return false;
}
export function armFailNext(): void {
  setItem(FAIL_NEXT_KEY, '1');
}

/** 清空所有协作数据并重新播种。 */
export function resetAll(server: ServerState): ServerState {
  const fresh = createSeedServer();
  server.issues = fresh.issues;
  server.events = fresh.events;
  server.aliases = fresh.aliases;
  server.appliedOps = fresh.appliedOps;
  server.clock = fresh.clock;
  saveServer(server);
  if (typeof localStorage !== 'undefined') {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith('a11y-audit-cm-replica-v2:')) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  }
  return fresh;
}
