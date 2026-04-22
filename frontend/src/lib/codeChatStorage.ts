/** 代码问答页：浏览器本地多会话存储（localStorage） */

import { randomId } from "@/lib/randomId";

export const CODE_CHAT_STORAGE_KEY = "gv_code_chat_sessions_v1";

const STORAGE_VERSION = 1 as const;
const MAX_SESSIONS = 50;
const MAX_TURNS_PER_SESSION = 250;

export type StoredHit = {
  score?: number | null;
  distance?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
};

export type StoredChatImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

export type StoredChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: StoredChatImage[];
  sources?: StoredHit[];
  retrievalQuery?: string;
  streaming?: boolean;
};

export type ChatSession = {
  id: string;
  /** 列表展示用，通常取首条用户消息摘要 */
  title: string;
  updatedAt: number;
  projectId: string;
  topK: number;
  turns: StoredChatTurn[];
};

type PersistedPayload = {
  v: typeof STORAGE_VERSION;
  activeId: string;
  sessions: ChatSession[];
};

let emptyBootstrap: { sessions: ChatSession[]; activeId: string } | null = null;

export function createChatSession(): ChatSession {
  return {
    id: randomId(),
    title: "",
    updatedAt: Date.now(),
    projectId: "",
    topK: 12,
    turns: [],
  };
}

function clampTopK(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 12;
  return Math.min(30, Math.max(1, x));
}

function sanitizeTurn(t: unknown): StoredChatTurn | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (o.role !== "user" && o.role !== "assistant") return null;
  if (typeof o.id !== "string" || typeof o.content !== "string") return null;
  const base: StoredChatTurn = {
    id: o.id,
    role: o.role,
    content: o.content,
    streaming: false,
  };
  if (Array.isArray(o.images)) {
    base.images = o.images.filter(
      (img): img is StoredChatImage =>
        !!img &&
        typeof img === "object" &&
        typeof (img as StoredChatImage).id === "string" &&
        typeof (img as StoredChatImage).name === "string" &&
        typeof (img as StoredChatImage).mimeType === "string" &&
        typeof (img as StoredChatImage).dataUrl === "string" &&
        typeof (img as StoredChatImage).size === "number",
    ) as StoredChatImage[];
  }
  if (typeof o.retrievalQuery === "string") base.retrievalQuery = o.retrievalQuery;
  if (Array.isArray(o.sources)) {
    base.sources = o.sources.filter(
      (s): s is StoredHit =>
        !!s &&
        typeof s === "object" &&
        typeof (s as StoredHit).content === "string",
    ) as StoredHit[];
  }
  return base;
}

function sanitizeSession(s: unknown): ChatSession | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  const turnsIn = Array.isArray(o.turns) ? o.turns : [];
  const turns: StoredChatTurn[] = [];
  for (const x of turnsIn) {
    const t = sanitizeTurn(x);
    if (t) turns.push(t);
  }
  return {
    id: o.id,
    title: typeof o.title === "string" ? o.title : "",
    updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
    projectId: typeof o.projectId === "string" ? o.projectId : "",
    topK: clampTopK(o.topK),
    turns: turns.slice(-MAX_TURNS_PER_SESSION),
  };
}

/** 首次无本地数据时，在 React Strict Mode 下多次调用 initializer 仍得到同一会话 */
export function readInitialCodeChatState(): { sessions: ChatSession[]; activeId: string } {
  if (typeof window === "undefined") {
    const s = createChatSession();
    return { sessions: [s], activeId: s.id };
  }
  try {
    const raw = window.localStorage.getItem(CODE_CHAT_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedPayload>;
      if (p.v === STORAGE_VERSION && Array.isArray(p.sessions) && p.sessions.length > 0) {
        const sessions = p.sessions.map(sanitizeSession).filter(Boolean) as ChatSession[];
        if (sessions.length === 0) {
          const s = createChatSession();
          return { sessions: [s], activeId: s.id };
        }
        const activeId =
          typeof p.activeId === "string" && sessions.some((x) => x.id === p.activeId)
            ? p.activeId
            : sessions[0].id;
        return { sessions, activeId };
      }
    }
  } catch {
    /* ignore */
  }
  if (emptyBootstrap) return emptyBootstrap;
  const s = createChatSession();
  emptyBootstrap = { sessions: [s], activeId: s.id };
  return emptyBootstrap;
}

/** 保留当前会话，其余按更新时间优先丢弃最旧的，避免写入时丢掉正在看的对话 */
function capSessions(sessions: ChatSession[], activeId: string): ChatSession[] {
  if (sessions.length <= MAX_SESSIONS) return sessions;
  const active = sessions.find((s) => s.id === activeId);
  const rest = sessions
    .filter((s) => s.id !== activeId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const limitRest = Math.max(0, MAX_SESSIONS - (active ? 1 : 0));
  const keptRest = rest.slice(0, limitRest);
  return active ? [active, ...keptRest] : keptRest.slice(0, MAX_SESSIONS);
}

export function persistCodeChatState(sessions: ChatSession[], activeId: string): void {
  if (typeof window === "undefined") return;
  try {
    const capped = capSessions(sessions, activeId);
    const payload: PersistedPayload = {
      v: STORAGE_VERSION,
      activeId,
      sessions: capped.map((s) => ({
        ...s,
        turns: s.turns.slice(-MAX_TURNS_PER_SESSION).map((t) => ({ ...t, streaming: false })),
      })),
    };
    window.localStorage.setItem(CODE_CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("[code chat] localStorage persist failed", e);
  }
}
