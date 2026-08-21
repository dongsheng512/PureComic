# PureComic

[![CI](https://github.com/dongsheng512/PureComic/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng512/PureComic/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-v0.4.0-6bb6ff)](https://github.com/dongsheng512/PureComic/tags)

本地优先的桌面端 **漫画增强 + 阅读 + 书库** 工具。

Local-first desktop **comic enhancer, reader, and library**.

技术栈：**Tauri 2 + Rust + React + TypeScript + Tailwind CSS**

当前版本：**v0.4.0**。引擎拉取与打包说明见 [scripts/README.md](scripts/README.md)。

## 能做什么

- **书库**：导入 Folder / ZIP / CBZ / CBR / EPUB / MOBI，封面、排序、外部打开
- **阅读器**：单页 / 双页、LTR / RTL、智能适应窗口；顶栏「AI 画质」按页增强
- **AI 画质（macOS Core ML）**
  - **Real-CUGAN Core ML**：2×，默认保守（护网点），可调去噪；阅读器与整本导出共用
  - **Waifu2x Core ML**：2×，可调去噪（轻度 / 标准 / 加强 / 最强）
  - **Real-ESRGAN Anime 4×**：4× 动漫超分（输入长边约 1024；阅读器）
  - 阅读器：当前页优先，再预热后续页（前方 4 + 回翻 1），结果写入本地缓存
  - 整本增强：同一套 Core ML 引擎导出 CBZ / ZIP / Folder

## 仓库结构

```text
PureComic/
├── apps/desktop/          # Tauri 2 + React + Tailwind UI
├── crates/
│   ├── comic-core/        # 导入导出、任务、阅读器增强缓存
│   ├── comic-engines/     # 引擎：mock / Core ML（Waifu2x、Real-CUGAN、Real-ESRGAN）
│   └── comic-cli/         # 命令行（purecomic）
├── third_party/           # Core ML pin / NOTICE；可选 ncnn-vulkan/ 见该目录 README
└── scripts/               # fetch / verify / macOS 打包
```

内部 crate 仍为 `comic-core` / `comic-engines` / `comic-cli`；CLI 可执行文件为 **`purecomic`**。

## 前置条件

- Rust stable（`rustup`）
- Node.js 20+
- macOS：Xcode Command Line Tools（Core ML 引擎仅 macOS）
- 增强引擎（macOS）：Core ML 模型，见下方 fetch 脚本

> 中国大陆网络环境可自行配置 crates.io 镜像（例如 `~/.cargo/config.toml` 指向
> rsproxy.cn），仓库不再内置全局镜像配置，以免影响海外贡献者与 CI。

## 开发

```bash
# Core ML 模型（macOS，下载后按 pin.json 校验 sha256）
./scripts/fetch-realcugan-coreml.sh
./scripts/fetch-waifu2x-coreml.sh
./scripts/fetch-realesrgan-coreml.sh

# 可选：ncnn-Vulkan sidecar（不进安装包，说明见 third_party/ncnn-vulkan/README.md）
# ./scripts/fetch-waifu2x.sh
# ./scripts/fetch-realcugan.sh

# 测试
cargo test -p comic-core
cargo test -p comic-engines

# 桌面端
cd apps/desktop
npm install
npm run tauri dev
```

CLI：

```bash
cargo run -p comic-cli -- doctor
cargo run -p comic-cli -- preview ./pages --page 0 --save-dir ./prev-out
cargo run -p comic-cli -- export-diagnostics -o ./diag
```

找不到 Core ML 模型时，开发配置可回退 mock；**发行包默认不回退**。强制 mock：`COMIC_USE_MOCK=1` 或 `purecomic --mock doctor`。

引擎与模型体积较大，**不入库**。Pin 与说明：`third_party/*.pin.json`、`third_party/NOTICE`、[scripts/README.md](scripts/README.md)。

### 性能

- 整本增强默认一次进程处理整本（目录批处理）
- 阅读器 Core ML 进程内推理，模型常驻；Real-CUGAN / Waifu2x 走 ANE/GPU，Real-ESRGAN Anime 4× 走同一套 Core ML
- 解压 / 导出可用 rayon 并行

```bash
export COMIC_WAIFU2X_JOBS=4:8:4
export COMIC_ENHANCE_MODE=directory      # 默认
export COMIC_ENHANCE_MODE=parallel
```

- Core ML 的 FastPrediction 特化默认关闭（waifu2x Double I/O 下实测更慢），
  如需实验：`COMIC_W2X_FASTPRED=1`（macOS 15+ 才生效）

拖放：Tauri `onDragDropEvent` 提供本机绝对路径，拖入 CBZ/ZIP/文件夹即可导入。

## macOS 打包

```bash
./scripts/fetch-realcugan-coreml.sh
./scripts/fetch-waifu2x-coreml.sh
./scripts/fetch-realesrgan-coreml.sh
./scripts/package-macos.sh
# 或
cd apps/desktop && npm run tauri:build:mac
```

产物在 `target/<triple>/release/bundle/`（不入库）。未公证时请右键「打开」。

## 许可

应用代码 **Apache-2.0**（见 [LICENSE](LICENSE)）。  
第三方引擎/模型见 [`third_party/NOTICE`](third_party/NOTICE)。
