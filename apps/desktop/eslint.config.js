import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri/gen"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 实验性新规则噪音大：很多「props 同步到 state」是合法模式，
      // 项目核心保护是 exhaustive-deps
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs-in-render": "off",
      // render 中同步「最新值 ref」是项目内广泛使用的合法模式
      "react-hooks/refs": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
