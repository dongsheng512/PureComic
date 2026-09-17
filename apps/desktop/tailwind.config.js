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
        // 深色表面阶梯：Apple systemGray6→3 (dark)，四档同族（B+2 冷灰），步长 1.22/1.23/1.24:1
        // ⚠️ 这四个值和 styles.css 的 --paper-deep/--surface-* 是同一套色，改一处必须改两处。
        //    这里不能写成 var(...)，因为 dark:bg-surface-raised/95 这类透明度修饰符
        //    需要能解析的颜色值（controls.tsx 用到了）。
        surface: {
          DEFAULT: "#1c1c1e",
          panel: "#2c2c2e",
          raised: "#3a3a3c",
          high: "#48484a",
        },
        fg: {
          DEFAULT: "#ececec",
          label: "#c5c5c5",
          muted: "#a6a6a6",
        },
        // 唯一主色：系统蓝
        accent: {
          DEFAULT: "#007aff",
          dim: "#0066d6",
          soft: "#eaf3ff",
          // 深底上的前景蓝（= styles.css 的 --accent-fg）。只在 dark: 变体里用。
          fg: "var(--accent-fg)",
        },
        // 语义成功色（浅色）：提高文字可读性，视觉仍保持原生绿
        success: {
          DEFAULT: "#248a3d",
          soft: "#effaf1",
        },
        // ⚠️ 下面四组是「深色专用」语义色，值直连 styles.css 的 token，
        //    所以只能配 `dark:` 变体用（如 dark:text-danger-fg）。浅色模式没有对应值，别裸用。
        //    fg = tint 底上的文字（提亮 80%，系统基色在 tint 上只有 2.9:1，不能当文字用）；
        //    DEFAULT = 实心基色（点 / 图标 / 填充）。
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
          border: "var(--danger-border)",
          fg: "var(--danger-fg)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
          border: "var(--warning-border)",
          fg: "var(--warning-fg)",
        },
        info: {
          DEFAULT: "var(--info)",
          soft: "var(--info-soft)",
          border: "var(--info-border)",
          fg: "var(--info-fg)",
        },
        // success 在浅色已有自己的值（上面），深色另立一个名字，避免动到浅色。
        ok: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
          border: "var(--success-border)",
          fg: "var(--success-fg)",
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
