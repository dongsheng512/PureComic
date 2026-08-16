# Scripts

引擎与模型**不提交到 Git**，由下列脚本下载到 `third_party/`。

## `fetch-waifu2x.sh`

Download and install **waifu2x-ncnn-vulkan** + **models-cunet** into `third_party/`.

```bash
./scripts/fetch-waifu2x.sh                 # current machine triple
./scripts/fetch-waifu2x.sh --target linux-x64
./scripts/fetch-waifu2x.sh --all           # all platforms (packaging)
./scripts/fetch-waifu2x.sh --tag 20220728  # override pin tag
```

Pin file: `third_party/waifu2x.pin.json`  
Checksums: `third_party/checksums.sha256`  
Cache: `third_party/.cache/waifu2x/`

If GitHub is unreachable:

```bash
export COMIC_GITHUB_MIRROR=https://ghfast.top/
./scripts/fetch-waifu2x.sh
```

## `fetch-realcugan.sh`

Download **realcugan-ncnn-vulkan** + `models-se` / `models-pro` / `models-nose`.

```bash
./scripts/fetch-realcugan.sh
./scripts/fetch-realcugan.sh --target darwin-arm64
```

Pin: `third_party/realcugan.pin.json`

## `fetch-waifu2x-coreml.sh`

Download **waifu2x-ios** Core ML 2× anime models (`noise0`–`noise3`) into `third_party/waifu2x-coreml/`. Used by the reader on macOS.

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

## `verify-waifu2x.sh`

SHA-256 check of files listed in `checksums.sha256`.

```bash
./scripts/verify-waifu2x.sh
./scripts/verify-waifu2x.sh --target darwin-arm64
```

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
./scripts/prepare-macos-bundle.sh   # copy sidecars + models into src-tauri
./scripts/package-macos.sh          # full app + dmg build
```

## Use real engine after fetch

```bash
cargo run -p comic-cli -- doctor
# force mock: COMIC_USE_MOCK=1  or  --mock
```
