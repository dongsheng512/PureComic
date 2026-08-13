# PureComic

本地优先的桌面端 **漫画增强 + 阅读 + 书库** 工具。

Local-first desktop **comic enhancer, reader, and library**.

以 **Waifu2x** 为核心，可选 **Real-CUGAN**；支持 Folder / ZIP / CBZ / CBR / EPUB / MOBI 导入，导出 CBZ / ZIP / Folder。

技术栈：**Tauri 2 + Rust core + React + TypeScript + Tailwind CSS**

| 文档 | 说明 |
|------|------|
| [docs/README.md](docs/README.md) | 文档索引 |
| [docs/design-comic-enhancer.md](docs/design-comic-enhancer.md) | 增强管线设计 |
| [docs/reader-schedule.md](docs/reader-schedule.md) | 阅读器 / 书库排期 |
| [docs/adr/](docs/adr/) | 架构决策记录 |

## 仓库结构

```text
PureComic/
├── apps/desktop/          # Tauri 2 + React + Tailwind UI
├── crates/
│   ├── comic-core/        # 导入导出、任务、调度（无 Tauri 依赖）
│   ├── comic-engines/     # UpscaleEngine + mock / waifu2x / realcugan
│   └── comic-cli/         # 命令行
├── third_party/           # pin / NOTICE；引擎与模型由脚本拉取
├── scripts/               # fetch / verify / macOS 打包
└── docs/                  # 设计与 ADR
```

> 内部 crate 名仍为 `comic-core` / `comic-engines` / `comic-cli`（历史命名，运行正常）。产品名与桌面包为 **PureComic**。

## 前置条件

- Rust stable（`rustup`）
- Node.js 20+（或 bun）
- macOS：Xcode Command Line Tools
- （可选）`waifu2x-ncnn-vulkan` / `realcugan-ncnn-vulkan` 用于真实超分；缺省时可用 mock 引擎

## 开发

```bash
# Rust 库与 CLI
cargo test -p comic-core
cargo test -p comic-engines
cargo run -p comic-cli -- doctor
cargo run -p comic-cli -- preview ./pages --page 0 --save-dir ./prev-out
cargo run -p comic-cli -- export-diagnostics -o ./diag

# 桌面端（React + Tailwind）
cd apps/desktop
npm install
npm run tauri dev
```

### 功能概览

- **导入**：Folder / ZIP / CBZ / **CBR·RAR**（系统 unrar）/ **EPUB** / **MOBI·AZW·AZW3**
- **导出**：CBZ / ZIP / Folder · JPEG / PNG / WebP · JPEG 质量
- **引擎**：Mock / Waifu2x sidecar / 可选 Real-CUGAN；任务队列、取消、磁盘预估
- **预览**：Before/After 单页对比（共享 GpuLock）
- **诊断**：Doctor + 诊断包 zip
- **书库 / 阅读**：本地书库与阅读器（见 [docs/reader-schedule.md](docs/reader-schedule.md)）
- **CLI**：`run` / `validate` / `estimate` / `preview` / `doctor` / `export-diagnostics`

### 拉取引擎（不要提交二进制）

引擎与模型体积较大，**不入库**；用脚本下载到 `third_party/`：

```bash
# Waifu2x + models-cunet
./scripts/fetch-waifu2x.sh
./scripts/verify-waifu2x.sh

# 可选：Real-CUGAN（黑白漫更锐，支持 2/3/4×）
./scripts/fetch-realcugan.sh

# 自检（应显示引擎就绪）
cargo run -p comic-cli -- doctor

# 强制 mock（无 GPU / CI）
cargo run -p comic-cli -- --mock doctor
# 或 COMIC_USE_MOCK=1
```

找不到真实二进制时，开发配置可回退 mock；**发行包默认不回退**。

Pin 与说明：`third_party/*.pin.json`、`third_party/NOTICE`、`scripts/README.md`。

### 性能（多线程）

- **增强默认目录批处理**：一次 `waifu2x` 进程处理整本（比逐页启动快很多）
- 自动加 `-j load:proc:save`（按 CPU 核数）
- **解压 / 导出编码** 用 rayon 并行

```bash
export COMIC_WAIFU2X_JOBS=4:8:4          # 更激进的线程
export COMIC_ENHANCE_MODE=directory      # 默认
export COMIC_ENHANCE_MODE=parallel       # 多进程逐页（一般更慢）
export COMIC_ENHANCE_CONCURRENCY=2
```

**拖放：** Tauri `onDragDropEvent` 提供本机绝对路径，拖入 CBZ/ZIP/文件夹即可导入。

## macOS 打包

只发当前 Mac 架构的 `.app` / `.dmg`，捆绑 Waifu2x 与 `models-cunet`。

```bash
./scripts/fetch-waifu2x.sh
./scripts/package-macos.sh
# 或
cd apps/desktop && npm run tauri:build:mac
```

产物（本地 `target/`，不入库）：

- `target/<triple>/release/bundle/macos/*.app`
- `target/<triple>/release/bundle/dmg/*.dmg`

未做 Apple 公证时，本机请右键「打开」。

## 许可

应用代码 **Apache-2.0**（见 [LICENSE](LICENSE)）。  
第三方引擎/模型见 [`third_party/NOTICE`](third_party/NOTICE)。
