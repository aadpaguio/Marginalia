import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ContextManifest } from "@/types/contextManifest";

export function useLatestManifest(
  threadId: string | null,
  refreshTrigger?: number
): ContextManifest | null {
  const [manifest, setManifest] = useState<ContextManifest | null>(null);

  useEffect(() => {
    if (threadId == null) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    invoke<ContextManifest | null>("db_get_latest_manifest_for_thread", {
      threadId,
    })
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, refreshTrigger]);

  return manifest;
}
