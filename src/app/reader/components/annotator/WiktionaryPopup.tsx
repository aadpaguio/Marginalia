import { useEffect, useRef, useState, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import ReaderPopup from "./ReaderPopup";
import styles from "./WiktionaryPopup.module.css";

type Definition = {
  definition: string;
  examples?: string[];
};

type Result = {
  partOfSpeech: string;
  definitions: Definition[];
  language: string;
};

export type WiktionaryLayout = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  anchorX: number;
  trianglePoints: "up" | "down";
};

type Props = {
  word: string;
  lang?: string | string[];
  layout: WiktionaryLayout;
  isDark: boolean;
  onDismiss?: () => void;
};

export default function WiktionaryPopup({ word, lang, layout, isDark, onDismiss }: Props) {
  const [history, setHistory] = useState<{ items: string[]; index: number }>({
    items: [word],
    index: 0,
  });
  const lastLookupRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const lastScrollTopRef = useRef(0);
  const lastDirectionRef = useRef<"up" | "down" | null>(null);
  const scrollDeltaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [isBackVisible, setIsBackVisible] = useState(false);
  const lookupWord = history.items[history.index] ?? word;
  const canGoBack = history.index > 0;
  const showBackButton = canGoBack && isBackVisible;

  useEffect(() => {
    setHistory({ items: [word], index: 0 });
  }, [word]);

  useEffect(() => {
    if (!canGoBack) {
      setIsBackVisible(false);
      lastScrollTopRef.current = 0;
      lastDirectionRef.current = null;
      scrollDeltaRef.current = 0;
      return;
    }
    setIsBackVisible(true);
  }, [canGoBack]);

  useEffect(() => {
    if (!canGoBack) return;
    const main = mainRef.current;
    if (!main) return;

    const handleScroll = () => {
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const currentScrollTop = main.scrollTop;
        const delta = currentScrollTop - lastScrollTopRef.current;
        if (delta === 0) return;

        if (currentScrollTop <= 4) {
          setIsBackVisible(true);
          lastDirectionRef.current = null;
          scrollDeltaRef.current = 0;
          lastScrollTopRef.current = currentScrollTop;
          return;
        }

        const direction: "up" | "down" = delta > 0 ? "down" : "up";
        if (direction !== lastDirectionRef.current) {
          lastDirectionRef.current = direction;
          scrollDeltaRef.current = 0;
        }

        scrollDeltaRef.current += Math.abs(delta);
        const hideThreshold = 14;
        const showThreshold = 8;

        if (direction === "down" && scrollDeltaRef.current >= hideThreshold) {
          setIsBackVisible(false);
          scrollDeltaRef.current = 0;
        } else if (direction === "up" && scrollDeltaRef.current >= showThreshold) {
          setIsBackVisible(true);
          scrollDeltaRef.current = 0;
        }

        lastScrollTopRef.current = currentScrollTop;
      });
    };

    lastScrollTopRef.current = main.scrollTop;
    main.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      main.removeEventListener("scroll", handleScroll);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [canGoBack]);

  useEffect(() => {
    setIsBackVisible(true);
    lastScrollTopRef.current = 0;
    lastDirectionRef.current = null;
    scrollDeltaRef.current = 0;
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
    }
  }, [lookupWord]);

  const pushHistory = useCallback((nextWord: string) => {
    const trimmedWord = nextWord.trim();
    if (!trimmedWord) return;
    setHistory((prev) => {
      const currentWord = prev.items[prev.index];
      if (currentWord === trimmedWord) return prev;
      const items = [...prev.items.slice(0, prev.index + 1), trimmedWord];
      return { items, index: items.length - 1 };
    });
  }, []);

  const handleBack = () => {
    setHistory((prev) => {
      if (prev.index === 0) return prev;
      return { ...prev, index: prev.index - 1 };
    });
  };

  const interceptDictLinks = (definition: string): HTMLElement[] => {
    const container = document.createElement("div");
    container.innerHTML = definition;

    const links = container.querySelectorAll<HTMLAnchorElement>('a[rel="mw:WikiLink"]');

    links.forEach((link) => {
      const title = link.getAttribute("title");
      if (title) {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          pushHistory(title);
        });
        link.className = styles.wikiLink;
      }
    });

    return Array.from(container.childNodes) as HTMLElement[];
  };

  useEffect(() => {
    const langCode = typeof lang === "string" ? lang : lang?.[0];
    const baseLang = langCode?.split(/[-_]/)[0];
    const lookupKey = `${lookupWord}::${baseLang || ""}`;
    const main = mainRef.current;
    const footer = footerRef.current;
    if (!main || !footer) return;
    if (lastLookupRef.current === lookupKey) return;
    lastLookupRef.current = lookupKey;

    const fetchDefinitions = async (w: string, language?: string) => {
      main.innerHTML = "";
      footer.dataset["state"] = "loading";

      try {
        const encoded = encodeURIComponent(w);
        const response = await fetch(
          `https://en.wiktionary.org/api/rest_v1/page/definition/${encoded}`
        );
        if (!response.ok) {
          throw new Error("Failed to fetch definitions");
        }

        const json = (await response.json()) as Record<string, Result[]>;
        const results: Result[] | undefined = language
          ? json[language] || json["en"]
          : json[Object.keys(json)[0]!];

        if (!results || results.length === 0) {
          throw new Error("No results found");
        }

        const hgroup = document.createElement("hgroup");
        const h1 = document.createElement("h1");
        h1.innerText = w;
        h1.className = styles.dictTitle;

        const p = document.createElement("p");
        p.innerText = results[0]!.language;
        p.className = styles.dictLang;

        hgroup.append(h1, p);
        main.append(hgroup);

        results.forEach(({ partOfSpeech, definitions: defs }: Result) => {
          const h2 = document.createElement("h2");
          h2.innerText = partOfSpeech;
          h2.className = styles.dictPos;

          const ol = document.createElement("ol");
          ol.className = styles.dictList;

          defs.forEach(({ definition, examples }: Definition) => {
            if (!definition) return;
            const li = document.createElement("li");
            const processedContent = interceptDictLinks(definition);
            li.append(...processedContent);

            if (examples) {
              const ul = document.createElement("ul");
              ul.className = styles.exampleList;

              examples.forEach((example) => {
                const exampleLi = document.createElement("li");
                exampleLi.innerHTML = example;
                ul.appendChild(exampleLi);
              });

              li.appendChild(ul);
            }

            ol.appendChild(li);
          });

          main.appendChild(h2);
          main.appendChild(ol);
        });

        footer.dataset["state"] = "loaded";
      } catch (error) {
        console.error(error);
        footer.dataset["state"] = "error";

        const div = document.createElement("div");
        div.className = styles.errorWrap;

        const h1 = document.createElement("h1");
        h1.innerText = "Error";
        h1.className = styles.dictTitle;

        const p = document.createElement("p");
        p.className = styles.errorText;
        const link = document.createElement("a");
        link.href = `https://en.wiktionary.org/w/index.php?search=${encodeURIComponent(w)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = styles.wikiLink;
        link.textContent = "Wiktionary";
        p.append("Unable to load this entry. Try searching on ");
        p.appendChild(link);
        p.append(".");

        div.append(h1, p);
        main.append(div);
      }
    };

    void fetchDefinitions(lookupWord, baseLang);
  }, [lookupWord, lang]);

  return (
    <ReaderPopup
      left={layout.left}
      top={layout.top}
      width={layout.width}
      maxHeight={layout.maxHeight}
      anchorX={layout.anchorX}
      trianglePoints={layout.trianglePoints}
      isDark={isDark}
      onDismiss={onDismiss}
    >
      <div className={`${styles.inner} ${isDark ? styles.innerDark : ""}`}>
        {canGoBack && (
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className={`${styles.backButton} ${showBackButton ? styles.backButtonVisible : styles.backButtonHidden}`}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <main
          ref={mainRef}
          className={styles.dictMain}
          style={{
            paddingTop: showBackButton ? 48 : 16,
            transition: "padding-top 180ms ease-out",
          }}
        />
        <footer
          ref={footerRef}
          className={styles.footer}
          data-state="loading"
        >
          <div className={styles.footerCredit}>Source: Wiktionary (CC BY-SA)</div>
        </footer>
      </div>
    </ReaderPopup>
  );
}
