import { useCallback, useRef, useState } from "react";
import { API_BASE, authHeaders } from "../api";

// Consumes GET /sessions/{id}/stream (Server-Sent Events) via fetch() +
// manual parsing instead of the browser EventSource API — EventSource can't
// set custom headers, and this app's data-plane auth (X-API-Key) is a
// header, not a query param (keeping it out of the URL/server logs is worth
// the extra parsing code). Frames look like `data: {...}\n\n`; a bare
// `: keep-alive\n\n` comment (no "data:" prefix) means nothing changed since
// the last frame and is silently skipped.
export default function useSessionStream() {
  const [status, setStatus] = useState(null);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setWatching(false);
  }, []);

  const start = useCallback(async (sessionId) => {
    stop(); // never run two streams at once
    if (!sessionId) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setStatus(null);
    setWatching(true);

    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionId}/stream`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Couldn't connect to the session stream (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; the last chunk in
        // `buffer` may be an incomplete frame still arriving, so hold it
        // back for the next read instead of parsing it early.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue; // a ": keep-alive" comment frame — nothing changed
          setStatus(JSON.parse(dataLine.slice("data: ".length)));
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      setWatching(false);
    }
  }, [stop]);

  return { status, watching, error, start, stop };
}
