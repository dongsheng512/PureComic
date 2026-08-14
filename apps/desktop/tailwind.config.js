/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // 浅色：Apple 系炭灰字 + 浅灰底（避免纯黑/爆白）
        ink: {
          50: "#ffffff",
          100: "#f5f5f7",
          200: "#e8e8ed",
          300: "#d2d2d7",
          400: "#a1a1a6",
          500: "#6e6e73",
          600: "#6e6e73",
          700: "#424245",
          800: "#1d1d1f",
          900: "#1d1d1f",
          950: "#1d1d1f",
        },
        // 深色模式表面：冷调石墨青灰（略抬 B 通道，避免黄暖）
        surface: {
          DEFAULT: "#16171C",
          panel: "#1C1D24",
          raised: "#2A2C36",
          high: "#323440",
        },
        // 深色文字：冷灰实色（不用半透明纯白，避免抗锯齿发黄）
        fg: {
          DEFAULT: "#E8EAEF",
          label: "#C2C7D1",
          muted: "#9399A5",
        },
        // 唯一高亮 · 主操作（淡天蓝）
        accent: {
          DEFAULT: "#6bb6ff",
          dim: "#4aa3f5",
          soft: "#eaf6ff",
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
        // 白卡片浮于浅灰底
        panel: "0 2px 10px rgba(0, 0, 0, 0.04)",
        cover: "inset 0 0 0 1px rgba(0, 0, 0, 0.08)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "0.9rem",
      },
    },
  },
  plugins: [],
};
