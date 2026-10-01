# Scripts

引擎与模型**不提交到 Git**，由下列脚本下载到 `third_party/`。

## ncnn-Vulkan（可选，不进安装包）

Waifu2x / Real-CUGAN 的 ncnn-Vulkan sidecar、pin、校验和与说明集中在
[`third_party/ncnn-vulkan/README.md`](../third_party/ncnn-vulkan/README.md)。

```bash
./scripts/fetch-waifu2x.sh
./scripts/fetch-realcugan.sh
./scripts/verify-waifu2x.sh
```

## `fetch-realcugan-coreml.sh`

从官方 Real-CUGAN `updated_weights.zip` 把 SE 2× 转成 Core ML `.mlpackage`（保守 / denoise1–3），写入 `third_party/realcugan-coreml/`。阅读器与整本导出的默认引擎。需要本机 `torch` + `coremltools`。

```bash
pip3 install torch coremltools
./scripts/fetch-realcugan-coreml.sh
```

Pin: `third_party/realcugan-coreml.pin.json`。`.mlpackage` 不入库。

## `fetch-waifu2x-coreml.sh`

Download **waifu2x-ios** Core ML 2× anime models (`noise0`–`noise3`) into `third_party/waifu2x-coreml/`。阅读器与整本导出共用。

```bash
./scripts/fetch-waifu2x-coreml.sh
```

Pin: `third_party/waifu2x-coreml.pin.json`（下载后强制 sha256 校验，不匹配即退出）。

## `fetch-realesrgan-coreml.sh`

Download **Real-ESRGAN Anime 4×** Core ML (`RealESRGAN_x4plus_anime_6B`) into `third_party/realesrgan-coreml/`. Used by the reader on macOS.

```bash
./scripts/fetch-realesrgan-coreml.sh
```

Pin: `third_party/realesrgan-coreml.pin.json`（下载后强制 sha256 校验，不匹配即退出）。

`.mlmodel` / `.mlmodelc` 不入库。

## `fetch-animevideo-coreml.sh`

Download **realesr-animevideov3**（Compact/SRVGGNet）权重并转换为 Core ML fp16 mlprogram，
写入 `third_party/animevideo-coreml/`。阅读器「极速」引擎（4×，ANE 友好）。
需要 `uv`（torch/coremltools 以 ephemeral 环境运行，无需手动装）。

```bash
./scripts/fetch-animevideo-coreml.sh
```

Pin: `third_party/animevideo-coreml.pin.json`（pth 下载后 sha256 校验；
转换脚本内置 fp16 vs fp32 数值校验，PSNR <40dB 即失败）。

`.mlpackage` / `.mlmodelc` 不入库。

## `re-export-fp16-coreml.py`

把两套 Core ML 模型权重量化到 fp16（waifu2x 顺带把 multiArray I/O Double→Float32），
用于后续 fp16 换包实验。产物默认写 `third_party/waifu2x-coreml-fp16/` 与
`third_party/realesrgan-coreml-fp16/`，**不覆盖原模型**；视觉验收通过后再接线 fetch/pin。

```bash
pip3 install coremltools
python3 scripts/re-export-fp16-coreml.py --verify
```

## macOS packaging

```bash
./scripts/prepare-macos-bundle.sh   # copy Core ML models into src-tauri
./scripts/package-macos.sh          # full app + dmg build
```

## Use real engine after fetch

桌面端从 `third_party/` 解析 Core ML 模型。强制 mock：`COMIC_USE_MOCK=1`。
