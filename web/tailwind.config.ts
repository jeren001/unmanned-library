import type { Config } from "tailwindcss";

// Mirrors the `@theme inline` block in src/styles.css (Tailwind v4 reads that one);
// every colour points at a runtime CSS variable so utilities follow data-theme.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        burgundy: "var(--burgundy)",
        "burgundy-deep": "var(--burgundy-deep)",
        rose: "var(--rose)",
        blush: "var(--blush)",
        wood: "var(--wood)",
        cream: "var(--cream)",
        paper: "var(--paper)",
        ink: "var(--ink)",
        line: "var(--line)",
        success: "var(--success)",
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        text: "var(--text)",
        "text-2": "var(--text-2)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        info: "var(--info)"
      },
      fontFamily: {
        serif: ["Songti SC", "Noto Serif SC", "Source Han Serif SC", "Georgia", "serif"],
        sans: ["system-ui", "-apple-system", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "Liberation Mono", "monospace"]
      },
      borderRadius: {
        control: "12px",
        panel: "16px"
      }
    }
  }
} satisfies Config;
