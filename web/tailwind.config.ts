import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        line: "var(--line)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        brass: "var(--brass)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        info: "var(--info)"
      },
      fontFamily: {
        display: ["Fraunces", "Noto Serif SC", "serif"],
        ui: ["Inter", "Noto Sans SC", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"]
      },
      fontSize: {
        xs: "0.75rem",
        sm: "0.875rem",
        base: "1rem",
        lg: "1.25rem",
        xl: "1.75rem",
        "2xl": "2.5rem",
        "3xl": "4rem"
      },
      borderRadius: {
        control: "6px",
        panel: "14px"
      },
      boxShadow: {
        hairline: "inset 0 0 0 1px var(--line)"
      },
      transitionDuration: {
        quiet: "180ms"
      }
    }
  }
} satisfies Config;
