/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // ChatGPT-like light surfaces: sidebar/header gray, main content white
        ink: {
          50: "#ffffff",
          100: "#f7f7f8",
          200: "#e5e5e5",
          300: "#d9d9e0",
          400: "#8e8e8e",
          500: "#6e6e6e",
          600: "#6e6e6e",
          700: "#424242",
          800: "#2f2f2f",
          900: "#2f2f2f",
          950: "#2f2f2f",
        },
        // Dark surfaces: main content #212121, sidebar/header #171717
        surface: {
          DEFAULT: "#212121",
          panel: "#171717",
          raised: "#2f2f2f",
          high: "#3a3a3a",
        },
        fg: {
          DEFAULT: "#ececec",
          label: "#c5c5c5",
          muted: "#9b9b9b",
        },
        // 唯一主色：系统蓝
        accent: {
          DEFAULT: "#007aff",
          dim: "#0066d6",
          soft: "#eaf3ff",
        },
        // 语义成功色：提高文字可读性，视觉仍保持原生绿
        success: {
          DEFAULT: "#248a3d",
          soft: "#effaf1",
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
        panel: "0 8px 24px rgba(35, 35, 45, 0.07)",
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
