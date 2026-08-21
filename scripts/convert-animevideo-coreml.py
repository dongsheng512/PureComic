#!/usr/bin/env python3
"""Convert realesr-animevideov3 (Compact / SRVGGNet) to Core ML mlpackage.

Fixed 512×512 image tile in → 2048×2048 out (4×), fp16 mlprogram, image I/O.
The compact arch has a ~37px receptive field; host tiling pads 10px per side.

Run via uv (no venv needed):
  uv run --with torch --with coremltools --with pillow --with numpy \
    python3 scripts/convert-animevideo-coreml.py \
    --weights third_party/.cache/animevideo-coreml/realesr-animevideov3.pth \
    --out third_party/animevideo-coreml/realesr_animevideov3_x4.mlpackage
"""

from __future__ import annotations

import argparse
import os
import time

import numpy as np

TILE = 512   # inner tile（宿主分片步长）
PAD = 10     # 感受野上下文，烘焙进模型输入（与 realcugan 同法）
IN = TILE + 2 * PAD  # 532：模型实际输入边长
SCALE = 4


def build_model(num_feat: int = 64, num_conv: int = 16):
    """Mirror Real-ESRGAN inference_realesrgan_video.py SRVGGNetCompact.

    与 basicsr 版本不同：激活层内联在 body ModuleList 中（conv/act 交错），
    权重键为 body.0..body.34（num_conv=16 时）。
    """
    import torch

    class SRVGGNetCompact(torch.nn.Module):
        def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=16, upscale=4, act_type="prelu"):
            super().__init__()
            self.num_in_ch = num_in_ch
            self.num_out_ch = num_out_ch
            self.num_feat = num_feat
            self.num_conv = num_conv
            self.upscale = upscale
            self.act_type = act_type

            self.body = torch.nn.ModuleList()
            self.body.append(torch.nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
            for _ in range(num_conv):
                if act_type == "relu":
                    act = torch.nn.ReLU(inplace=True)
                elif act_type == "leakyrelu":
                    act = torch.nn.LeakyReLU(negative_slope=0.1, inplace=True)
                elif act_type == "prelu":
                    act = torch.nn.PReLU(num_parameters=num_feat)
                else:
                    raise NotImplementedError(act_type)
                self.body.append(act)
                self.body.append(torch.nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            # 权重实测：最后一个隐藏 conv 之后还有一个激活（body.33 PReLU），再接输出 conv(body.34)
            if act_type == "relu":
                self.body.append(torch.nn.ReLU(inplace=True))
            elif act_type == "leakyrelu":
                self.body.append(torch.nn.LeakyReLU(negative_slope=0.1, inplace=True))
            elif act_type == "prelu":
                self.body.append(torch.nn.PReLU(num_parameters=num_feat))
            self.body.append(torch.nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
            self.upsampler = torch.nn.PixelShuffle(upscale)

        def forward(self, x):
            out = x
            for layer in self.body:
                out = layer(out)
            out = self.upsampler(out)
            base = torch.nn.functional.interpolate(x, scale_factor=self.upscale, mode="nearest")
            return out + base

    return SRVGGNetCompact(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=num_feat,
        num_conv=num_conv,
        upscale=SCALE,
        act_type="prelu",
    )


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    if mse <= 1e-12:
        return float("inf")
    return float(10.0 * np.log10(255.0 * 255.0 / mse))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--out", default="third_party/animevideo-coreml/realesr_animevideov3_x4.mlpackage")
    ap.add_argument("--skip-convert", action="store_true")
    args = ap.parse_args()

    import torch
    from PIL import Image

    net = build_model()
    sd = torch.load(args.weights, map_location="cpu", weights_only=True)
    if isinstance(sd, dict) and "params" in sd:
        sd = sd["params"]
    net.load_state_dict(sd, strict=True)
    net.eval()

    # 包装：输入含 PAD 环（来自宿主 reflect 画布），裁环后进网，
    # 使 模型(IN²)→TILE*SCALE² 与引擎常量严格一致
    import torch

    class PaddedInput(torch.nn.Module):
        def __init__(self, inner, inner_net):
            super().__init__()
            self.inner = inner
            self.net = inner_net  # 注册为子模块，否则 trace 时参数被视为需梯度的常量

        def forward(self, x):
            return self.net(x[:, :, PAD : PAD + self.inner, PAD : PAD + self.inner])

    wrapped = PaddedInput(TILE, net).eval()

    example = torch.zeros(1, 3, IN, IN)
    with torch.no_grad():
        chk = wrapped(example)
    if tuple(chk.shape) != (1, 3, TILE * SCALE, TILE * SCALE):
        raise RuntimeError(f"unexpected shape {tuple(chk.shape)}")
    print(f"pytorch ok  in {IN}²  out {TILE*SCALE}²")

    if not args.skip_convert:
        import coremltools as ct

        with torch.no_grad():
            traced = torch.jit.trace(wrapped, example, strict=True)
        print("traced")
        # 注意：coremltools 9 的 ImageType I/O 路径实测输出错乱（PSNR ~5dB），
        # 与 realcugan 同方案改用 float32 张量 I/O（[0,1] CHW），归一化由宿主层负责
        mlmodel = ct.convert(
            traced,
            inputs=[ct.TensorType(name="input", shape=example.shape, dtype=np.float32)],
            outputs=[ct.TensorType(name="output", dtype=np.float32)],
            convert_to="mlprogram",
            compute_precision=ct.precision.FLOAT16,
            minimum_deployment_target=ct.target.macOS13,
        )
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        if os.path.exists(args.out):
            import shutil

            shutil.rmtree(args.out) if os.path.isdir(args.out) else os.remove(args.out)
        mlmodel.save(args.out)
        print(f"wrote {args.out}")
    else:
        import coremltools as ct

        mlmodel = ct.models.MLModel(args.out)

    # ---- numeric check: fp16 Core ML vs fp32 PyTorch on identical tiles ----
    rng = np.random.default_rng(42)
    tiles = {
        "zeros": np.zeros((IN, IN, 3), np.uint8),
        "noise": rng.integers(0, 256, (IN, IN, 3), dtype=np.uint8),
        "gradient": np.tile(
            np.linspace(0, 255, IN, dtype=np.uint8)[None, :, None], (IN, 1, 3)
        ),
    }
    cml = ct.models.MLModel(args.out, compute_units=ct.ComputeUnit.ALL)
    spec = cml.get_spec()
    print(f"coreml I/O  {spec.description.input[0].name} -> {spec.description.output[0].name}")

    def cml_tile(arr: np.ndarray) -> np.ndarray:
        inp = arr.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        y = cml.predict({"input": inp})["output"]
        return np.clip(np.rint(y.squeeze(0).transpose(1, 2, 0) * 255.0), 0, 255).astype(np.uint8)

    worst = 999.0
    for name, arr in tiles.items():
        with torch.no_grad():
            gold = (
                wrapped(torch.from_numpy(arr.transpose(2, 0, 1)[None].astype(np.float32) / 255.0))
                .squeeze(0)
                .permute(1, 2, 0)
                .numpy()
            )
        gold_u8 = np.clip(np.rint(gold * 255.0), 0, 255).astype(np.uint8)
        got = cml_tile(arr)
        p = psnr(got, gold_u8)
        worst = min(worst, p)
        print(f"tile[{name}]  psnr(coreml vs pytorch) {p:.2f} dB")

    # ---- timing ----
    _ = cml_tile(tiles["gradient"])
    times = []
    for _ in range(5):
        t0 = time.perf_counter()
        _ = cml_tile(tiles["gradient"])
        times.append((time.perf_counter() - t0) * 1000)
    avg = sum(times) / len(times)
    print(f"avg {avg:.0f} ms/tile ({IN}²→{TILE*SCALE}², ALL units)")
    if worst < 40.0:
        print(f"FAIL: worst psnr {worst:.2f} dB < 40")
        return 1
    print(f"OK worst psnr {worst:.2f} dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
