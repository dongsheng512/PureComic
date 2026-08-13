/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7fb",
          100: "#eceef6",
          200: "#d5d9eb",
          300: "#b0b8d6",
          400: "#8590ba",
          500: "#6672a3",
          600: "#515a88",
          700: "#43496e",
          800: "#3a3f5c",
          900: "#33364e",
          950: "#1c1e2e",
        },
        accent: {
          DEFAULT: "#7c5cff",
          dim: "#5b3fd4",
          soft: "#efeaff",
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
        panel: "0 10px 40px -12px rgba(28, 30, 46, 0.35)",
      },
    },
  },
  plugins: [],
};
