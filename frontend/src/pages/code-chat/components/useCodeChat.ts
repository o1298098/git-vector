import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { apiFetch, apiJson } from "@/lib/api";
import { randomId } from "@/lib/randomId";
import {
  type ChatSession,
  createChatSession,
  persistCodeChatState,
  readInitialCodeChatState,
  type StoredChatTurn as ChatTurn,
  type StoredHit as Hit,
} from "@/lib/codeChatStorage";
import { useI18n } from "@/i18n/I18nContext";
import type { CodeChatProjectOption } from "./types";

/** 流式「打字机」：与网络分包解耦，按固定节奏逐字（略加速追赶积压） */
const STREAM_TYPING_TICK_MS = 26;
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_CHARS = 10_000;
const MAX_HISTORY_TURN_CHARS = 3_000;

type ChatHistoryTurnPayload = {
  role: "user" | "assistant";
  content: string;
};
type SubmitFeedbackStatus = "accepted" | "duplicate" | "failed";

export function useCodeChat() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ChatSession[]>(() => readInitialCodeChatState().sessions);
  const [activeId, setActiveId] = useState<string>(() => readInitialCodeChatState().activeId);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [typingBusy, setTypingBusy] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [projects, setProjects] = useState<CodeChatProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [feedbackByTurn, setFeedbackByTurn] = useState<Record<string, 1 | -1>>({});
  const feedbackByTurnRef = useRef<Record<string, 1 | -1>>({});
  const feedbackSubmittingRef = useRef<Set<string>>(new Set());

  const buildHistoryPayload = useCallback((rawTurns: ChatTurn[]): ChatHistoryTurnPayload[] => {
    const source = rawTurns.slice(-MAX_HISTORY_TURNS);
    const normalized: ChatHistoryTurnPayload[] = [];
    let totalChars = 0;
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const turn = source[i];
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const content = (turn.content || "").trim().slice(0, MAX_HISTORY_TURN_CHARS);
      if (!content) continue;
      if (totalChars + content.length > MAX_HISTORY_CHARS) break;
      normalized.push({ role: turn.role, content });
      totalChars += content.length;
    }
    normalized.reverse();
    return normalized;
  }, []);

  const activeSession = useMemo(() => {
    const s = sessions.find((x) => x.id === activeId);
    if (s) return s;
    return sessions[0] ?? createChatSession();
  }, [sessions, activeId]);

  const projectId = activeSession.projectId;
  const topK = activeSession.topK;
  const turns = activeSession.turns;

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  /** 流式输出时跳过写入，避免每个 token 都 JSON.stringify 全量会话阻塞主线程 */
  useEffect(() => {
    const streamingNow = sessions.some(
      (s) => s.id === activeId && s.turns.some((t) => t.streaming),
    );
    if (streamingNow) return;
    persistCodeChatState(sessions, activeId);
  }, [sessions, activeId]);

  useEffect(() => {
    if (sessions.length > 0 && !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  const setTurns = useCallback(
    (updater: SetStateAction<ChatTurn[]>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeId) return s;
          const nextTurns = typeof updater === "function" ? updater(s.turns) : updater;
          let title = s.title;
          const firstUser = nextTurns.find((row) => row.role === "user" && row.content.trim());
          if (firstUser) {
            const line = firstUser.content.replace(/\s+/g, " ").trim();
            title = line.length > 40 ? `${line.slice(0, 40)}…` : line;
          } else if (nextTurns.length === 0) title = "";
          return { ...s, turns: nextTurns, title, updatedAt: Date.now() };
        }),
      );
    },
    [activeId],
  );

  const streamTypeRef = useRef({
    target: "",
    displayLen: 0,
    timer: null as ReturnType<typeof setInterval> | null,
    done: false,
    assistantId: "",
  });
  const streamAbortRef = useRef<AbortController | null>(null);

  const clearStreamTyping = useCallback(() => {
    const t = streamTypeRef.current.timer;
    if (t != null) {
      clearInterval(t);
      streamTypeRef.current.timer = null;
    }
  }, []);

  const resetStreamTyping = useCallback(() => {
    clearStreamTyping();
    streamTypeRef.current.target = "";
    streamTypeRef.current.displayLen = 0;
    streamTypeRef.current.done = false;
    streamTypeRef.current.assistantId = "";
  }, [clearStreamTyping]);

  const startStreamTyping = useCallback(
    (assistantId: string) => {
      clearStreamTyping();
      streamTypeRef.current.done = false;
      streamTypeRef.current.assistantId = assistantId;
      streamTypeRef.current.timer = setInterval(() => {
        const target = streamTypeRef.current.target;
        let len = streamTypeRef.current.displayLen;
        if (len >= target.length) {
          if (streamTypeRef.current.done && streamTypeRef.current.assistantId === assistantId) {
            clearStreamTyping();
            setTypingBusy(false);
            setTurns((prev) =>
              prev.map((x) =>
                x.id === assistantId ? { ...x, content: target, streaming: false } : x,
              ),
            );
          }
          return;
        }
        const lag = target.length - len;
        const step = lag > 180 ? Math.min(4, Math.max(2, Math.ceil(lag / 90))) : 1;
        const next = Math.min(len + step, target.length);
        streamTypeRef.current.displayLen = next;
        const finishNow =
          next >= target.length &&
          streamTypeRef.current.done &&
          streamTypeRef.current.assistantId === assistantId;
        setTurns((prev) =>
          prev.map((x) =>
            x.id === assistantId
              ? {
                  ...x,
                  content: target.slice(0, next),
                  ...(finishNow ? { streaming: false } : {}),
                }
              : x,
          ),
        );
        if (finishNow) {
          clearStreamTyping();
          setTypingBusy(false);
        }
      }, STREAM_TYPING_TICK_MS);
    },
    [clearStreamTyping, setTurns],
  );

  const markStreamDone = useCallback(
    (assistantId: string) => {
      streamTypeRef.current.done = true;
      streamTypeRef.current.assistantId = assistantId;
      if (streamTypeRef.current.displayLen >= streamTypeRef.current.target.length) {
        clearStreamTyping();
        setTurns((prev) =>
          prev.map((x) =>
            x.id === assistantId
              ? { ...x, content: streamTypeRef.current.target, streaming: false }
              : x,
          ),
        );
      }
    },
    [clearStreamTyping, setTurns],
  );

  const snapStreamToTarget = useCallback(
    (assistantId: string, patch: { streaming: boolean; contentOverride?: string }) => {
      clearStreamTyping();
      setTypingBusy(false);
      const content = patch.contentOverride ?? streamTypeRef.current.target;
      streamTypeRef.current.target = content;
      streamTypeRef.current.displayLen = content.length;
      setTurns((prev) =>
        prev.map((x) =>
          x.id === assistantId ? { ...x, content, streaming: patch.streaming } : x,
        ),
      );
    },
    [clearStreamTyping, setTurns],
  );

  const setProjectId = useCallback(
    (v: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, projectId: v, updatedAt: Date.now() } : s)),
      );
    },
    [activeId],
  );

  const setTopK = useCallback(
    (v: number) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, topK: v, updatedAt: Date.now() } : s)),
      );
    },
    [activeId],
  );

  const newChat = useCallback(() => {
    if (loading || typingBusy) return;
    setEditingUserId(null);
    const s = createChatSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
  }, [loading, typingBusy]);

  const selectSession = useCallback(
    (id: string) => {
      if (loading || typingBusy || id === activeId) return;
      setEditingUserId(null);
      setActiveId(id);
    },
    [loading, typingBusy, activeId],
  );

  const deleteSession = useCallback(
    (id: string) => {
      if (loading || typingBusy) return;
      setSessions((prev) => {
        const filtered = prev.filter((s) => s.id !== id);
        const next = filtered.length === 0 ? [createChatSession()] : filtered;
        setActiveId((aid) => {
          if (aid !== id) return aid;
          if (filtered.length === 0) return next[0].id;
          const idx = prev.findIndex((s) => s.id === id);
          const neighbor = prev[idx + 1] ?? prev[idx - 1];
          const pick = next.find((s) => s.id === neighbor?.id) ?? next[0];
          return pick.id;
        });
        return next;
      });
    },
    [loading, typingBusy],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<{ projects: CodeChatProjectOption[] }>("/api/projects");
        if (!cancelled) setProjects(data.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const streamAssistant = useCallback(
    async (userMessage: string, assistantId: string, historyTurns: ChatTurn[]) => {
      const trimmed = userMessage.trim();
      if (!trimmed) return;
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setLoading(true);
      setTypingBusy(true);
      const body = JSON.stringify({
        message: trimmed,
        project_id: projectId.trim() || null,
        top_k: topK,
        history: buildHistoryPayload(historyTurns),
      });
      const aid = assistantId;
      try {
        const res = await apiFetch("/api/code-chat/stream", {
          method: "POST",
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          setTypingBusy(false);
          let detail = res.statusText;
          try {
            const j = await res.json();
            if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
          } catch {
            /* ignore */
          }
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.errorBubble", { detail }),
            },
          ]);
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          setTypingBusy(false);
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.errorBubble", { detail: "No response body" }),
            },
          ]);
          return;
        }
        resetStreamTyping();
        const dec = new TextDecoder();
        let buf = "";
        let metaReceived = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (;;) {
            const sep = buf.indexOf("\n\n");
            if (sep < 0) break;
            const block = buf.slice(0, sep).trim();
            buf = buf.slice(sep + 2);
            if (!block.startsWith("data:")) continue;
            const raw = block.slice(5).trim();
            let data: {
              event?: string;
              text?: string;
              retrieval_query?: string;
              sources?: Hit[];
              message?: string;
              intent?: string;
            };
            try {
              data = JSON.parse(raw) as typeof data;
            } catch {
              continue;
            }
            const ev = data.event;
            if (ev === "meta") {
              if (!metaReceived) {
                metaReceived = true;
                streamTypeRef.current.target = "";
                streamTypeRef.current.displayLen = 0;
                setTurns((prev) => [
                  ...prev,
                  {
                    id: aid,
                    role: "assistant",
                    content: "",
                    sources: data.sources ?? [],
                    retrievalQuery: data.retrieval_query,
                    streaming: true,
                  },
                ]);
                startStreamTyping(aid);
              }
            } else if (ev === "delta" && data.text) {
              if (!metaReceived) {
                metaReceived = true;
                streamTypeRef.current.target = data.text ?? "";
                streamTypeRef.current.displayLen = 0;
                setTurns((prev) => [
                  ...prev,
                  {
                    id: aid,
                    role: "assistant",
                    content: "",
                    streaming: true,
                  },
                ]);
                startStreamTyping(aid);
              } else {
                streamTypeRef.current.target += data.text;
              }
            } else if (ev === "done") {
              markStreamDone(aid);
            } else if (ev === "error") {
              const errText = data.message ?? t("chat.sendFail");
              if (!metaReceived) {
                metaReceived = true;
                setTypingBusy(false);
                resetStreamTyping();
                setTurns((prev) => [
                  ...prev,
                  { id: aid, role: "assistant", content: errText, streaming: false },
                ]);
              } else {
                snapStreamToTarget(aid, {
                  streaming: false,
                  contentOverride:
                    streamTypeRef.current.target.trim().length > 0
                      ? streamTypeRef.current.target
                      : errText,
                });
              }
            }
          }
        }
        if (!metaReceived) {
          setTypingBusy(false);
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.streamAborted"),
              streaming: false,
            },
          ]);
        } else {
          markStreamDone(aid);
        }
      } catch (e: unknown) {
        if (controller.signal.aborted) {
          snapStreamToTarget(aid, {
            streaming: false,
            contentOverride:
              streamTypeRef.current.target.trim().length > 0 ? streamTypeRef.current.target : t("chat.streamStopped"),
          });
          return;
        }
        clearStreamTyping();
        setTypingBusy(false);
        setTurns((prev) => [
          ...prev,
          {
            id: aid,
            role: "assistant",
            content: t("chat.errorBubble", { detail: e instanceof Error ? e.message : t("chat.sendFail") }),
          },
        ]);
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
        setLoading(false);
      }
    },
    [
      projectId,
      topK,
      t,
      buildHistoryPayload,
      setTurns,
      resetStreamTyping,
      startStreamTyping,
      markStreamDone,
      snapStreamToTarget,
      clearStreamTyping,
    ],
  );

  const stopGenerating = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);

  const doSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading || typingBusy) return;
      setEditingUserId(null);
      const uid = randomId();
      const aid = randomId();
      const historyBeforeSend = turns;
      setTurns((prev) => [...prev, { id: uid, role: "user", content: trimmed }]);
      await streamAssistant(trimmed, aid, historyBeforeSend);
    },
    [loading, typingBusy, streamAssistant, setTurns, turns],
  );

  const handleUserEditConfirm = useCallback(
    (userTurnId: string, nextRaw: string) => {
      const trimmed = (nextRaw || "").trim();
      setEditingUserId(null);
      if (!trimmed || loading || typingBusy) return;
      let historyBeforeEditedMessage: ChatTurn[] = [];
      setTurns((prev) => {
        const i = prev.findIndex((x) => x.id === userTurnId);
        if (i < 0 || prev[i].role !== "user") return prev;
        historyBeforeEditedMessage = prev.slice(0, i);
        return [...prev.slice(0, i), { ...prev[i], content: trimmed }];
      });
      void streamAssistant(trimmed, randomId(), historyBeforeEditedMessage);
    },
    [loading, typingBusy, streamAssistant, setTurns],
  );

  const handleRetryAssistant = useCallback(
    (assistantTurnId: string) => {
      if (loading || typingBusy) return;
      setEditingUserId(null);
      let userMsg = "";
      let historyBeforeUserMessage: ChatTurn[] = [];
      setTurns((prev) => {
        const j = prev.findIndex((x) => x.id === assistantTurnId);
        if (j <= 0) return prev;
        const u = prev[j - 1];
        if (u.role !== "user") return prev;
        userMsg = u.content.trim();
        historyBeforeUserMessage = prev.slice(0, Math.max(0, j - 1));
        return prev.slice(0, j);
      });
      if (!userMsg) return;
      void streamAssistant(userMsg, randomId(), historyBeforeUserMessage);
    },
    [loading, typingBusy, streamAssistant, setTurns],
  );

  const submitFeedback = useCallback(
    async (assistantTurnId: string, rating: 1 | -1): Promise<SubmitFeedbackStatus> => {
      if (
        feedbackByTurnRef.current[assistantTurnId] != null ||
        feedbackSubmittingRef.current.has(assistantTurnId)
      ) {
        return "duplicate";
      }
      feedbackSubmittingRef.current.add(assistantTurnId);
      feedbackByTurnRef.current[assistantTurnId] = rating;
      setFeedbackByTurn((prev) => ({ ...prev, [assistantTurnId]: rating }));
      try {
        const res = await apiFetch("/api/code-chat/feedback", {
          method: "POST",
          body: JSON.stringify({
            rating,
            project_id: projectId.trim() || null,
          }),
        });
        if (!res.ok) {
          delete feedbackByTurnRef.current[assistantTurnId];
          setFeedbackByTurn((prev) => {
            const next = { ...prev };
            delete next[assistantTurnId];
            return next;
          });
          return "failed";
        }
        return "accepted";
      } catch {
        delete feedbackByTurnRef.current[assistantTurnId];
        setFeedbackByTurn((prev) => {
          const next = { ...prev };
          delete next[assistantTurnId];
          return next;
        });
        return "failed";
      } finally {
        feedbackSubmittingRef.current.delete(assistantTurnId);
      }
    },
    [projectId],
  );

  return {
    input,
    setInput,
    loading: loading || typingBusy,
    editingUserId,
    setEditingUserId,
    turns,
    projectId,
    topK,
    projects,
    projectsLoading,
    sortedSessions,
    activeId,
    feedbackByTurn,
    setProjectId,
    setTopK,
    setTurns,
    newChat,
    selectSession,
    deleteSession,
    doSend,
    stopGenerating,
    submitFeedback,
    handleUserEditConfirm,
    handleRetryAssistant,
  };
}
