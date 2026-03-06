/**
 * Reader CSS for light, sepia, and dark themes.
 * Font: Literata, Merriweather, serif. No re-render — inject via setStyles.
 */

export type ReaderTheme = "light" | "sepia" | "dark";

/* Aligned with design tokens (tokens.css) so book page matches Page surface. */
const THEMES: Record<
  ReaderTheme,
  { bg: string; fg: string; link: string; colorScheme: string }
> = {
  light: {
    bg: "#f5f0e8",
    fg: "#1e1810",
    link: "#0066cc",
    colorScheme: "light",
  },
  sepia: {
    bg: "#ebe0d4",
    fg: "#2a2218",
    link: "#0066cc",
    colorScheme: "light",
  },
  dark: {
    bg: "#1c1914",
    fg: "#f0e8dc",
    link: "#7eb8da",
    colorScheme: "dark",
  },
};

const FONT_STACK = '"Literata", "Merriweather", Georgia, serif';

export function getReaderStyles(theme: ReaderTheme): string {
  const { bg, fg, link, colorScheme } = THEMES[theme];
  return `
    html, body { min-height: 100%; }
    html {
      --theme-bg-color: ${bg};
      --theme-fg-color: ${fg};
      color-scheme: ${colorScheme};
      background: ${bg} !important;
      color: ${fg} !important;
    }
    body {
      font-family: ${FONT_STACK};
      font-size: 1rem;
      line-height: 1.6;
      margin: 1em;
      color: ${fg} !important;
      background: ${bg} !important;
    }
    a { color: ${link}; }
    img { max-width: 100%; height: auto; }
  `.trim();
}

/** @deprecated Use getReaderStyles('light') for default. */
export function getMinimalReaderStyles(): string {
  return getReaderStyles("light");
}
