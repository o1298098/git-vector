import { useCallback, useEffect, useMemo, useState, type SetStateAction } from "react";
import { apiFetch, apiJson } from "@/lib/api";
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

export function useCodeChat() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ChatSession[]>(() => readInitialCodeChatState().sessions);
  const [activeId, setActiveId] = useState<string>(() => readInitialCodeChatState().activeId);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [projects, setProjects] = useState<CodeChatProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

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

  useEffect(() => {
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
    if (loading) return;
    setEditingUserId(null);
    const s = createChatSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
  }, [loading]);

  const selectSession = useCallback(
    (id: string) => {
      if (loading || id === activeId) return;
      setEditingUserId(null);
      setActiveId(id);
    },
    [loading, activeId],
  );

  const deleteSession = useCallback(
    (id: string) => {
      if (loading) return;
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
    [loading],
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
    async (userMessage: string, assistantId: string) => {
      const trimmed = userMessage.trim();
      if (!trimmed) return;
      setLoading(true);
      const body = JSON.stringify({
        message: trimmed,
        project_id: projectId.trim() || null,
        top_k: topK,
      });
      const aid = assistantId;
      try {
        const res = await apiFetch("/api/code-chat/stream", {
          method: "POST",
          body,
        });
        if (!res.ok) {
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
                setLoading(false);
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
              }
            } else if (ev === "delta" && data.text) {
              if (!metaReceived) {
                metaReceived = true;
                setLoading(false);
                setTurns((prev) => [
                  ...prev,
                  {
                    id: aid,
                    role: "assistant",
                    content: data.text ?? "",
                    streaming: true,
                  },
                ]);
              } else {
                setTurns((prev) =>
                  prev.map((x) => (x.id === aid ? { ...x, content: x.content + data.text! } : x)),
                );
              }
            } else if (ev === "done") {
              setTurns((prev) =>
                prev.map((x) => (x.id === aid ? { ...x, streaming: false } : x)),
              );
            } else if (ev === "error") {
              const errText = data.message ?? t("chat.sendFail");
              setLoading(false);
              if (!metaReceived) {
                metaReceived = true;
                setTurns((prev) => [
                  ...prev,
                  { id: aid, role: "assistant", content: errText, streaming: false },
                ]);
              } else {
                setTurns((prev) =>
                  prev.map((x) =>
                    x.id === aid ? { ...x, content: x.content || errText, streaming: false } : x,
                  ),
                );
              }
            }
          }
        }
        if (!metaReceived) {
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
          setTurns((prev) =>
            prev.map((x) => (x.id === aid && x.streaming ? { ...x, streaming: false } : x)),
          );
        }
      } catch (e: unknown) {
        setTurns((prev) => [
          ...prev,
          {
            id: aid,
            role: "assistant",
            content: t("chat.errorBubble", { detail: e instanceof Error ? e.message : t("chat.sendFail") }),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [projectId, topK, t, setTurns],
  );

  const doSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;
      setEditingUserId(null);
      const uid = crypto.randomUUID();
      const aid = crypto.randomUUID();
      setTurns((prev) => [...prev, { id: uid, role: "user", content: trimmed }]);
      await streamAssistant(trimmed, aid);
    },
    [loading, streamAssistant, setTurns],
  );

  const handleUserEditConfirm = useCallback(
    (userTurnId: string, nextRaw: string) => {
      const trimmed = (nextRaw || "").trim();
      setEditingUserId(null);
      if (!trimmed || loading) return;
      setTurns((prev) => {
        const i = prev.findIndex((x) => x.id === userTurnId);
        if (i < 0 || prev[i].role !== "user") return prev;
        return [...prev.slice(0, i), { ...prev[i], content: trimmed }];
      });
      void streamAssistant(trimmed, crypto.randomUUID());
    },
    [loading, streamAssistant, setTurns],
  );

  const handleRetryAssistant = useCallback(
    (assistantTurnId: string) => {
      if (loading) return;
      setEditingUserId(null);
      let userMsg = "";
      setTurns((prev) => {
        const j = prev.findIndex((x) => x.id === assistantTurnId);
        if (j <= 0) return prev;
        const u = prev[j - 1];
        if (u.role !== "user") return prev;
        userMsg = u.content.trim();
        return prev.slice(0, j);
      });
      if (!userMsg) return;
      void streamAssistant(userMsg, crypto.randomUUID());
    },
    [loading, streamAssistant, setTurns],
  );

  return {
    input,
    setInput,
    loading,
    editingUserId,
    setEditingUserId,
    turns,
    projectId,
    topK,
    projects,
    projectsLoading,
    sortedSessions,
    activeId,
    setProjectId,
    setTopK,
    setTurns,
    newChat,
    selectSession,
    deleteSession,
    doSend,
    handleUserEditConfirm,
    handleRetryAssistant,
  };
}
