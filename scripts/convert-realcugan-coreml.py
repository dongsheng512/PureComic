#!/usr/bin/env python3
"""Convert Real-CUGAN 2× PyTorch weights to Core ML (.mlpackage) and bench vs Vulkan.

Default: SE conservative 2×, tile inner 384 + 18px reflect pad (input 420² → output 768²).
Host tiling uses the same pad; SE stats are per-tile (same class of approximation as ncnn).

Example:
  python3 scripts/convert-realcugan-coreml.py \\
    --weights /tmp/realcugan-pt/weights_zip/updated_weights/up2x-latest-conservative.pth \\
    --src /tmp/w2x_qa/in_crop.png \\
    --vulkan /tmp/w2x_qa/cugan_cons.png
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAD = 18
INNER_DEFAULT = 384


def _load_pt_classes(upcunet_py: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location("upcunet_v3", upcunet_py)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(upcunet_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _patch_crop_forwards(inner) -> None:
    """Replace F.pad(..., negative) crops with slices — Core ML pad ops reject negatives."""
    import torch
    from torch.nn import functional as F

    u1 = inner.unet1
    u2 = inner.unet2

    def unet1_forward(x):
        x1 = u1.conv1(x)
        x2 = u1.conv1_down(x1)
        x1 = x1[:, :, 4:-4, 4:-4]
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x2 = u1.conv2(x2)
        x2 = u1.conv2_up(x2)
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x3 = u1.conv3(x1 + x2)
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        return u1.conv_bottom(x3)

    def unet2_forward(x, alpha: float = 1.0):
        x1 = u2.conv1(x)
        x2 = u2.conv1_down(x1)
        x1 = x1[:, :, 16:-16, 16:-16]
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x2 = u2.conv2(x2)
        x3 = u2.conv2_down(x2)
        x2 = x2[:, :, 4:-4, 4:-4]
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        x3 = u2.conv3(x3)
        x3 = u2.conv3_up(x3)
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        x4 = u2.conv4(x2 + x3)
        x4 = x4 * alpha
        x4 = u2.conv4_up(x4)
        x4 = F.leaky_relu(x4, 0.1, inplace=True)
        x5 = u2.conv5(x1 + x4)
        x5 = F.leaky_relu(x5, 0.1, inplace=True)
        return u2.conv_bottom(x5)

    def se_forward(self, x):
        x0 = torch.mean(x, dim=(2, 3), keepdim=True)
        x0 = self.conv1(x0)
        x0 = F.relu(x0, inplace=True)
        x0 = self.conv2(x0)
        x0 = torch.sigmoid(x0)
        return torch.mul(x, x0)

    u1.forward = unet1_forward
    u2.forward = unet2_forward
    for m in inner.modules():
        if m.__class__.__name__ == "SEBlock":
            m.forward = se_forward.__get__(m, m.__class__)


class Traceable2x:
    """Built after loading official UpCunet2x weights."""

    @staticmethod
    def wrap(inner, alpha: float = 1.0):
        from torch import nn

        _patch_crop_forwards(inner)

        class _M(nn.Module):
            def __init__(self):
                super().__init__()
                self.unet1 = inner.unet1
                self.unet2 = inner.unet2
                self.alpha = float(alpha)

            def forward(self, x):
                y = self.unet1(x)
                y0 = self.unet2(y, self.alpha)
                y = y[:, :, 20:-20, 20:-20]
                return y0 + y

        return _M()


def reflect_pad_hwc(rgb: np.ndarray, pad: int, ph: int, pw: int) -> np.ndarray:
    h, w, _ = rgb.shape
    return np.pad(
        rgb,
        ((pad, pad + ph - h), (pad, pad + pw - w), (0, 0)),
        mode="reflect",
    )


def tile_infer_numpy(predict_tile, rgb: np.ndarray, inner: int) -> np.ndarray:
    """predict_tile: (1,3,inner+2*PAD,inner+2*PAD) float32 [0,1] → same layout 2× inner."""
    h, w, _ = rgb.shape
    ph = ((h + inner - 1) // inner) * inner
    pw = ((w + inner - 1) // inner) * inner
    canvas = reflect_pad_hwc(rgb, PAD, ph, pw)
    out = np.zeros((ph * 2, pw * 2, 3), np.float32)
    inn = inner + 2 * PAD
    for y in range(0, ph, inner):
        for x in range(0, pw, inner):
            tile = canvas[y : y + inn, x : x + inn]
            inp = np.transpose(tile, (2, 0, 1))[None].astype(np.float32) / 255.0
            pred = predict_tile(inp)
            if pred.ndim == 4:
                pred = pred[0]
            pred = np.transpose(pred, (1, 2, 0))
            out[y * 2 : (y + inner) * 2, x * 2 : (x + inner) * 2] = pred
    crop = out[: h * 2, : w * 2]
    return np.clip(np.rint(crop * 255.0), 0, 255).astype(np.uint8)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    if mse <= 1e-12:
        return float("inf")
    return float(10.0 * np.log10(255.0 * 255.0 / mse))


def maxdiff(a: np.ndarray, b: np.ndarray) -> int:
    return int(np.max(np.abs(a.astype(np.int16) - b.astype(np.int16))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, help="up2x-latest-conservative.pth")
    ap.add_argument(
        "--upcunet",
        default="/tmp/realcugan-pt/upcunet_v3.py",
        help="official upcunet_v3.py",
    )
    ap.add_argument("--inner", type=int, default=INNER_DEFAULT)
    ap.add_argument("--out", default="/tmp/realcugan-coreml/up2x_conservative.mlpackage")
    ap.add_argument("--src", default="", help="input PNG/JPEG to upscale")
    ap.add_argument("--vulkan", default="", help="Vulkan PNG to compare against")
    ap.add_argument("--skip-convert", action="store_true")
    ap.add_argument(
        "--compute",
        default="ALL",
        choices=["ALL", "CPU_AND_GPU", "CPU_AND_NE", "CPU_ONLY"],
    )
    args = ap.parse_args()

    import torch
    from torch.nn import functional as F

    inner = args.inner
    inn = inner + 2 * PAD
    out_side = inner * 2

    mod = _load_pt_classes(args.upcunet)
    net = mod.UpCunet2x()
    sd = torch.load(args.weights, map_location="cpu", weights_only=True)
    net.load_state_dict(sd, strict=True)
    net.eval()
    wrapped = Traceable2x.wrap(net, alpha=1.0).eval()

    example = torch.zeros(1, 3, inn, inn)
    with torch.no_grad():
        chk = wrapped(example)
    if tuple(chk.shape) != (1, 3, out_side, out_side):
        raise RuntimeError(f"unexpected wrap shape {tuple(chk.shape)} want 1,3,{out_side},{out_side}")
    print(f"pytorch wrap ok  in {inn}²  out {out_side}²")

    if not args.skip_convert:
        import coremltools as ct

        with torch.no_grad():
            traced = torch.jit.trace(wrapped, example, strict=True)
        print("traced")
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

        mlmodel = None

    if not args.src:
        return 0

    from PIL import Image
    import coremltools as ct

    units = getattr(ct.ComputeUnit, args.compute)
    cml = ct.models.MLModel(args.out, compute_units=units)
    spec = cml.get_spec()
    in_name = spec.description.input[0].name
    out_name = spec.description.output[0].name
    print(f"coreml I/O  {in_name} -> {out_name}  compute={args.compute}")

    src = np.array(Image.open(args.src).convert("RGB"))
    print(f"src {src.shape[1]}x{src.shape[0]}")

    def pt_tile(inp: np.ndarray) -> np.ndarray:
        t = torch.from_numpy(inp)
        with torch.no_grad():
            y = wrapped(t).numpy()
        return y

    def cml_tile(inp: np.ndarray) -> np.ndarray:
        pred = cml.predict({in_name: inp})
        y = pred[out_name]
        return np.array(y)

    # one dummy tile to compile Core ML
    dummy = np.zeros((1, 3, inn, inn), np.float32)
    _ = cml_tile(dummy)

    t0 = time.perf_counter()
    with torch.no_grad():
        # official tile_mode=0 whole-image gold (SE over full image)
        rgb = torch.from_numpy(src.transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
        gold_t = net(rgb, 0, 0, 1.0, False)
        gold = gold_t.squeeze(0).permute(1, 2, 0).cpu().numpy()
    gold_ms = (time.perf_counter() - t0) * 1000
    print(f"pytorch tile_mode=0  {gold_ms:.0f} ms  {gold.shape[1]}x{gold.shape[0]}")

    t0 = time.perf_counter()
    pt_tiles = tile_infer_numpy(pt_tile, src, inner)
    pt_ms = (time.perf_counter() - t0) * 1000
    print(f"pytorch per-tile     {pt_ms:.0f} ms")

    times = []
    cml_img = None
    for i in range(3):
        t0 = time.perf_counter()
        cml_img = tile_infer_numpy(cml_tile, src, inner)
        times.append((time.perf_counter() - t0) * 1000)
        print(f"coreml  infer{i+1}     {times[-1]:.0f} ms")
    assert cml_img is not None

    print(
        f"psnr coreml vs pytorch-tile  {psnr(cml_img, pt_tiles):.2f} dB  maxdiff={maxdiff(cml_img, pt_tiles)}"
    )
    print(
        f"psnr coreml vs pytorch-full  {psnr(cml_img, gold):.2f} dB  maxdiff={maxdiff(cml_img, gold)}"
    )

    if args.vulkan and os.path.isfile(args.vulkan):
        vk = np.array(Image.open(args.vulkan).convert("RGB"))
        if vk.shape != cml_img.shape:
            print(f"vulkan size {vk.shape} != coreml {cml_img.shape}, skip pixel cmp")
        else:
            print(
                f"psnr coreml vs vulkan      {psnr(cml_img, vk):.2f} dB  maxdiff={maxdiff(cml_img, vk)}"
            )
            print(
                f"psnr pytorch-full vs vulkan {psnr(gold, vk):.2f} dB  maxdiff={maxdiff(gold, vk)}"
            )

    out_dir = os.path.dirname(args.out) or "."
    Image.fromarray(cml_img).save(os.path.join(out_dir, "coreml_out.png"))
    Image.fromarray(gold).save(os.path.join(out_dir, "pytorch_full.png"))
    Image.fromarray(pt_tiles).save(os.path.join(out_dir, "pytorch_tile.png"))
    print(f"wrote previews in {out_dir}")
    _ = F  # keep import used if tracing needs it later
    return 0


if __name__ == "__main__":
    sys.exit(main())
