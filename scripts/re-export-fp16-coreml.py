#!/usr/bin/env python3
"""fp16 重导出 CoreML 模型 —— docs/coreml-model-optimization-plan-2026-08-16.md 步骤 4。

- waifu2x-coreml（up_anime_noise0..3_scale2x_model）:
    权重 Float32 → fp16；输入/输出 Double → Float32（形状保持 156×156×3，不改 tile）。
- realesrgan-coreml（RealESRGAN_x4plus_anime_6B）:
    权重 Float32 → fp16；保持 Image I/O（避免 .m 大改）。

默认输出到 third_party/<engine>-coreml-fp16/，不覆盖仓库内现有模型；
用 --verify 重新加载产物并打印 I/O 描述与 sha256（供 fetch 脚本 pin）。

依赖：pip3 install coremltools（本机未装时脚本只打印用法说明并退出）。
"""

import argparse
import hashlib
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

W2X_MODELS = [
    "up_anime_noise0_scale2x_model.mlmodel",
    "up_anime_noise1_scale2x_model.mlmodel",
    "up_anime_noise2_scale2x_model.mlmodel",
    "up_anime_noise3_scale2x_model.mlmodel",
]
ESR_MODELS = ["RealESRGAN_x4plus_anime_6B.mlmodel"]


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def set_float32_io(spec) -> None:
    """waifu2x 专用：multiArray I/O 声明 Double → Float32。"""
    from coremltools.proto import FeatureTypes_pb2 as ft

    changed = False
    for feat in list(spec.description.input) + list(spec.description.output):
        if feat.type.HasField("multiArrayType"):
            feat.type.multiArrayType.dataType = ft.ArrayFeatureType.FLOAT32
            changed = True
    if not changed:
        print("warning: no multiArray I/O found, nothing changed")


def reexport(src: str, dst: str, float32_io: bool, verify: bool) -> None:
    import coremltools as ct
    from coremltools.models.neural_network import quantization_utils

    print(f"load   {src}")
    # ct>=7 的 quantize_weights 吃 MLModel 返回 MLModel；nbits=16 + linear = fp16 权重
    model = ct.models.MLModel(src)
    qmodel = quantization_utils.quantize_weights(model, nbits=16, quantization_mode="linear")
    spec = qmodel.get_spec()
    if float32_io:
        set_float32_io(spec)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    ct.utils.save_spec(spec, dst)
    print(f"write  {dst}")
    if verify:
        m = ct.models.MLModel(dst)
        print("  input :", [(f.name, f.type.WhichOneof("Type")) for f in m.get_spec().description.input])
        print("  output:", [(f.name, f.type.WhichOneof("Type")) for f in m.get_spec().description.output])
    print(f"  sha256: {sha256(dst)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="fp16 re-export CoreML models (plan step 4)")
    ap.add_argument("--out", help="output root dir (default third_party/<engine>-coreml-fp16)")
    ap.add_argument("--verify", action="store_true", help="reload outputs and print I/O desc + sha256")
    args = ap.parse_args()

    try:
        import coremltools  # noqa: F401
    except ImportError:
        print("coremltools 未安装。请先: pip3 install coremltools")
        return 2

    w2x_src = os.path.join(REPO_ROOT, "third_party", "waifu2x-coreml")
    esr_src = os.path.join(REPO_ROOT, "third_party", "realesrgan-coreml")
    w2x_out = args.out or os.path.join(REPO_ROOT, "third_party", "waifu2x-coreml-fp16")
    esr_out = args.out or os.path.join(REPO_ROOT, "third_party", "realesrgan-coreml-fp16")

    for name in W2X_MODELS:
        src = os.path.join(w2x_src, name)
        if not os.path.isfile(src):
            print(f"skip   {src} (missing)")
            continue
        reexport(src, os.path.join(w2x_out, name), float32_io=True, verify=args.verify)

    for name in ESR_MODELS:
        src = os.path.join(esr_src, name)
        if not os.path.isfile(src):
            print(f"skip   {src} (missing)")
            continue
        reexport(src, os.path.join(esr_out, name), float32_io=False, verify=args.verify)

    print("done — 产物在 *-coreml-fp16/，未动仓库内原模型；视觉验收后再更新 fetch 脚本与 pin。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
