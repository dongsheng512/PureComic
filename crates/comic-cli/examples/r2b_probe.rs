//! R2-B 视觉验收探测器（临时工具，验收完成后可删）。
//! 直接以显式模型路径构造 Core ML 引擎，跑单页并写出 PNG，
//! 使 fp32/fp16 对比无需换包、无需清编译缓存。
//!
//! 用法:
//!   cargo run -p comic-cli --example r2b_probe -- <w2x|esrgan> <model_path> <noise> <input> <output>

use comic_engines::{
    EngineKind, EnhanceBatchRequest, EnhanceParams, QualityPreset, RealEsrganCoreMlEngine,
    ScaleFactor, UpscaleEngine, Waifu2xCoreMlEngine,
};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        eprintln!("usage: r2b_probe <w2x|esrgan> <model_path> <noise> <input> <output>");
        std::process::exit(2);
    }
    let kind = match args[1].as_str() {
        "w2x" => EngineKind::Waifu2xCoreMl,
        "esrgan" => EngineKind::RealEsrganCoreMl,
        other => {
            eprintln!("unknown engine: {other}");
            std::process::exit(2);
        }
    };
    let model = PathBuf::from(&args[2]);
    let noise: i8 = args[3].parse()?;
    let input = PathBuf::from(&args[4]);
    let output = PathBuf::from(&args[5]);

    let params = EnhanceParams {
        engine: kind,
        scale: if kind == EngineKind::RealEsrganCoreMl {
            ScaleFactor::X4
        } else {
            ScaleFactor::X2
        },
        noise_level: noise,
        preset: QualityPreset::Balanced,
        tile_size: None,
        gpu_id: None,
        tta: false,
        jobs: None,
        output_format: Some("png".into()),
        cugan_model: None,
    };

    let t0 = std::time::Instant::now();
    let result = match kind {
        EngineKind::Waifu2xCoreMl => {
            Waifu2xCoreMlEngine::new(model)
                .enhance_batch(
                    EnhanceBatchRequest::SingleFile {
                        input,
                        output,
                        params,
                    },
                    CancellationToken::new(),
                )
                .await?
        }
        _ => {
            RealEsrganCoreMlEngine::new(model)
                .enhance_batch(
                    EnhanceBatchRequest::SingleFile {
                        input,
                        output,
                        params,
                    },
                    CancellationToken::new(),
                )
                .await?
        }
    };
    eprintln!(
        "ok pages_ok={} ms={}",
        result.pages_ok,
        t0.elapsed().as_millis()
    );
    Ok(())
}
