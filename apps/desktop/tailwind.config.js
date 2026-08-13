/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // 黑白基底 · 冷浅灰（干净、无杂色）
        ink: {
          50: "#ffffff",
          100: "#f8fafc",
          200: "#f1f5f9",
          300: "#e2e8f0",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
          950: "#000000",
        },
        // 唯一高亮 · AI / 增强动作（全站仅此用途）
        accent: {
          DEFAULT: "#5b5ce2",
          dim: "#4546c7",
          soft: "#eef0ff",
        },
        // 完成态语义（非营销高亮）
        success: {
          DEFAULT: "#0f766e",
          soft: "#ecfdf8",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
      boxShadow: {
        panel: "0 8px 24px -12px rgba(15, 23, 42, 0.12)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "0.9rem",
      },
    },
  },
  plugins: [],
};
