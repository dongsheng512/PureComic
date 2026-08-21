# ncnn-vulkan（可选 / 不进产品包）

本目录集中存放 **Waifu2x** 与 **Real-CUGAN** 的 ncnn-Vulkan sidecar，**不是** 应用默认引擎。

v0.4.0 起，阅读器与整本导出都走 Core ML（`third_party/waifu2x-coreml`、`realcugan-coreml`、`realesrgan-coreml`）。这里只留给本机 CLI 调试、对照画质、或没有 Core ML 的平台。

| 引擎 | 上游 | 本目录内容 | CLI id |
|---|---|---|---|
| Waifu2x | [nihui/waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan) | `waifu2x-ncnn-vulkan/bin/` + `models-cunet/` | `waifu2x-vulkan` |
| Real-CUGAN | [nihui/realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan) | `realcugan-ncnn-vulkan/bin/` + `models-se` / `pro` / `nose` | `realcugan-vulkan` |

许可见同目录 [NOTICE](NOTICE)。二进制与权重 **不入库**，由脚本按 pin 下载。

## 布局

```text
third_party/ncnn-vulkan/
├── README.md                 # 本说明
├── NOTICE                    # 上游许可摘录
├── waifu2x.pin.json          # 发布 tag / 资源名
├── realcugan.pin.json
├── checksums.sha256          # Waifu2x 二进制与 CUnet 权重哈希
├── models-cunet/             # Waifu2x CUnet（noise0–3、2×）
├── waifu2x-ncnn-vulkan/bin/<triple>/waifu2x-ncnn-vulkan
└── realcugan-ncnn-vulkan/
    ├── bin/<triple>/realcugan-ncnn-vulkan
    ├── models-se/            # 护网点，2/3/4×
    ├── models-pro/           # 更高质量，噪声档有限
    └── models-nose/          # 更快，固定 2× / n0
```

`<triple>`：`darwin-arm64` / `darwin-x64` / `linux-x64` / `windows-x64`。

当前 pin：

- Waifu2x：`20210210`（macOS zip 在较新 tag 上经常 404）
- Real-CUGAN：`20220728`

## 下载

仓库根目录：

```bash
# 当前机器架构
./scripts/fetch-waifu2x.sh
./scripts/fetch-realcugan.sh

# 指定平台 / 全平台
./scripts/fetch-waifu2x.sh --target darwin-arm64
./scripts/fetch-waifu2x.sh --all
./scripts/fetch-realcugan.sh --target linux-x64

./scripts/verify-waifu2x.sh
./scripts/verify-waifu2x.sh --target darwin-arm64
```

GitHub 访问不畅时（显式镜像，默认不走第三方）：

```bash
export COMIC_GITHUB_MIRROR=https://ghfast.top/
./scripts/fetch-waifu2x.sh
./scripts/fetch-realcugan.sh
```

缓存：`third_party/ncnn-vulkan/.cache/`。

## CLI

产品默认仍是 Core ML。要用本目录引擎，任务里写：

- `waifu2x-vulkan` / `waifu2x-ncnn`
- `realcugan-vulkan` / `realcugan-ncnn`

旧 id `waifu2x`、`realcugan` 已映射到 Core ML，**不会**再走 Vulkan。

```bash
cargo run -p comic-cli -- doctor
```

`doctor` 会列出 Vulkan sidecar 是否在本目录被解析到。没有二进制时不影响桌面端。

## 和 Core ML 的关系

- **不要**把本目录拷进 `apps/desktop/src-tauri/resources`，打包脚本也不会带 Vulkan。
- 画质对照：Vulkan Real-CUGAN SE 2× conservative ≈ 阅读器 Real-CUGAN Core ML；Vulkan Waifu2x CUnet ≈ Waifu2x Core ML，但 Core ML 走 ANE，通常更快。
- 分辨率：Vulkan CUGAN 可到 4×；Core ML 产品路径固定 2×（ESRGAN 阅读器 4×）。
