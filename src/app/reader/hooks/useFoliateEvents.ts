import { useEffect } from "react";
import type { FoliateView } from "@/types/view";

type FoliateEventHandler = {
  onLoad?: (event: Event) => void;
  onRelocate?: (event: Event) => void;
  onLinkClick?: (event: Event) => void;
  onRendererRelocate?: (event: Event) => void;
};

export function useFoliateEvents(
  view: FoliateView | null,
  handlers?: FoliateEventHandler
) {
  const onLoad = handlers?.onLoad;
  const onRelocate = handlers?.onRelocate;
  const onLinkClick = handlers?.onLinkClick;
  const onRendererRelocate = handlers?.onRendererRelocate;

  useEffect(() => {
    if (!view) return;
    if (onLoad) view.addEventListener("load", onLoad);
    if (onRelocate) view.addEventListener("relocate", onRelocate);
    if (onLinkClick) view.addEventListener("link", onLinkClick);
    if (onRendererRelocate)
      view.renderer.addEventListener("relocate", onRendererRelocate);

    return () => {
      if (onLoad) view.removeEventListener("load", onLoad);
      if (onRelocate) view.removeEventListener("relocate", onRelocate);
      if (onLinkClick) view.removeEventListener("link", onLinkClick);
      if (onRendererRelocate)
        view.renderer.removeEventListener("relocate", onRendererRelocate);
    };
  }, [view]);
}
