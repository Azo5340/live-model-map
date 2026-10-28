import { useEffect, useRef, useState } from "react";
import { fetchSnapshot, type Snapshot } from "./api";

export type FetchState = "loading" | "ok" | "error";

const POLL_MS = 60_000;

/** Re-reads the published data every minute and hands each snapshot to onData. */
export function useLiveData(onData: (s: Snapshot) => void): { state: FetchState; error: string | null } {
  const [state, setState] = useState<FetchState>("loading");
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onData);
  handler.current = onData;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const snapshot = await fetchSnapshot();
        if (stopped) return;
        handler.current(snapshot);
        setState("ok");
        setError(null);
      } catch (e) {
        if (stopped) return;
        setState("error");
        setError(String(e));
      }
      timer = window.setTimeout(poll, POLL_MS);
    };

    // Re-check right away when the tab comes back into view.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      poll();
    };

    poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { state, error };
}
