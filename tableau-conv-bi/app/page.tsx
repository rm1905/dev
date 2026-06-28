"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant";
type Theme = "dark" | "light";

interface ChatMessage {
  role: Role;
  display: string; // text shown in the UI
  // What we send back to the API on the next turn. User = string;
  // assistant = the structured content blocks returned by the server.
  apiContent: string | unknown[];
  tools: string[]; // Tableau tool names invoked during this turn
  toolError?: boolean;
  error?: string;
}

const EXAMPLES = [
  "List the published data sources I have access to.",
  "What workbooks are in the Sales project?",
  "What was total revenue by region last quarter?",
];

export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("theme") as Theme | null;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const initialTheme = storedTheme ?? (prefersLight ? "light" : "dark");
    setTheme(initialTheme);
    document.documentElement.setAttribute("data-theme", initialTheme);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const userMsg: ChatMessage = {
        role: "user",
        display: trimmed,
        apiContent: trimmed,
        tools: [],
      };
      // Placeholder assistant message we'll stream into.
      const assistantMsg: ChatMessage = {
        role: "assistant",
        display: "",
        apiContent: [],
        tools: [],
      };

      const history = [...messages, userMsg];
      setMessages([...history, assistantMsg]);
      setInput("");
      setBusy(true);

      // Index of the assistant message we're updating.
      const aIdx = history.length;

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m, i) => (i === aIdx ? fn(m) : m)));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.apiContent })),
          }),
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          patch((m) => ({ ...m, error: err.error || `HTTP ${res.status}` }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const json = line.slice(5).trim();
            if (!json) continue;

            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(json);
            } catch {
              continue;
            }

            switch (evt.type) {
              case "text":
                patch((m) => ({ ...m, display: m.display + (evt.text as string) }));
                break;
              case "tool_use": {
                const name = (evt.name as string) ?? "tool";
                patch((m) =>
                  m.tools.includes(name) ? m : { ...m, tools: [...m.tools, name] },
                );
                break;
              }
              case "tool_error":
                patch((m) => ({ ...m, toolError: true }));
                break;
              case "done":
                patch((m) => ({ ...m, apiContent: (evt.content as unknown[]) ?? [] }));
                break;
              case "error":
                patch((m) => ({ ...m, error: evt.message as string }));
                break;
            }
          }
        }
      } catch (e) {
        patch((m) => ({
          ...m,
          error: e instanceof Error ? e.message : "Network error",
        }));
      } finally {
        setBusy(false);
      }
    },
    [busy, messages],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="dot" />
        <h1>Tableau Conversational BI</h1>
        <span className="sub">Claude + Tableau MCP</span>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <h2>Ask your Tableau instance anything</h2>
            <p>
              Questions are answered live by Claude using your Tableau MCP server&apos;s tools.
            </p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const streaming = busy && isLast && m.role === "assistant";
          return (
            <div key={i} className={`msg ${m.role}`}>
              <span className="role">{m.role === "user" ? "You" : "Assistant"}</span>

              {m.tools.length > 0 && (
                <div className="tools">
                  {m.tools.map((t) => (
                    <span
                      key={t}
                      className={`tool-chip ${m.toolError ? "err" : streaming ? "live" : ""}`}
                    >
                      🔧 {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="bubble">
                {m.role === "assistant" ? (
                  <>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.display}</ReactMarkdown>
                    {streaming && m.display === "" && m.tools.length === 0 && (
                      <span className="cursor" />
                    )}
                  </>
                ) : (
                  m.display
                )}
                {m.error && <div className="error">⚠ {m.error}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your Tableau data…  (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={busy}
        />
        <button onClick={() => send(input)} disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
      <div className="hint">
        Connected to Tableau via MCP · responses generated by Claude · verify figures before
        sharing
      </div>
    </div>
  );
}
