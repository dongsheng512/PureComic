use clap::{Parser, Subcommand};
use comic_core::config::AppConfig;
use comic_core::job::{CreateJobRequest, EnhanceDto, JobState, OutputOptionsDto};
use comic_core::preview::EnhanceOptionsDto;
use comic_core::Scheduler;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(name = "purecomic", version, about = "PureComic CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Commands,
    /// 强制 mock 引擎（最近邻）。默认使用真实 Waifu2x（需 third_party 已 fetch）
    #[arg(long, global = true, default_value_t = false)]
    mock: bool,
    /// 工作目录
    #[arg(long, global = true)]
    work_root: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// 运行增强任务
    Run {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "balanced")]
        preset: String,
        #[arg(long, default_value_t = 2)]
        scale: u8,
        #[arg(long, default_value = "cbz")]
        container: String,
        #[arg(long, default_value = "jpeg")]
        format: String,
        #[arg(long, default_value_t = 92)]
        jpeg_quality: u8,
    },
    /// 校验源文件
    Validate { input: PathBuf },
    /// 估算临时磁盘占用
    Estimate {
        input: PathBuf,
        #[arg(long, default_value_t = 2)]
        scale: u8,
    },
    /// 单页预览（写出 before/after PNG 路径信息到 JSON）
    Preview {
        input: PathBuf,
        #[arg(long, default_value_t = 0)]
        page: u32,
        #[arg(long, default_value = "balanced")]
        preset: String,
        #[arg(long, default_value_t = 2)]
        scale: u8,
        /// 可选：将 data URL 解码写出目录
        #[arg(long)]
        save_dir: Option<PathBuf>,
    },
    /// 引擎与 GPU 自检
    Doctor,
    /// 导出诊断包 zip
    ExportDiagnostics {
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// 列出 GPU（mock 或引擎）
    ListGpus,
    /// 清理已结束/僵尸任务目录
    ClearJobs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let mut cfg = AppConfig::from_env();
    // --mock forces mock; otherwise keep from_env (default real Waifu2x)
    if cli.mock {
        cfg.use_mock_engine = true;
    }
    if let Some(w) = cli.work_root {
        cfg.work_root = w;
    }
    cfg.ensure_dirs()?;
    let sched = Scheduler::new(cfg)?;

    match cli.cmd {
        Commands::Validate { input } => {
            let v = sched
                .validate_source_path(&input.display().to_string())
                .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "kind": format!("{:?}", v.kind),
                    "pageCount": v.page_count,
                    "hasComicInfo": v.has_comic_info,
                    "warnings": v.warnings,
                    "pages": v.page_names,
                }))?
            );
        }
        Commands::Estimate { input, scale } => {
            let e = sched
                .estimate(&input.display().to_string(), scale)
                .await?;
            println!("{}", serde_json::to_string_pretty(&e)?);
        }
        Commands::Preview {
            input,
            page,
            preset,
            scale,
            save_dir,
        } => {
            let res = sched
                .preview_page(
                    &input.display().to_string(),
                    page,
                    Some(EnhanceOptionsDto {
                        preset: Some(preset),
                        scale: Some(scale),
                        ..Default::default()
                    }),
                )
                .await?;
            if let Some(dir) = save_dir {
                std::fs::create_dir_all(&dir)?;
                save_data_url(&res.before_data_url, &dir.join("before.png"))?;
                save_data_url(&res.after_data_url, &dir.join("after.png"))?;
                eprintln!("saved to {}", dir.display());
            }
            // omit huge base64 from stdout summary unless no save_dir
            let summary = serde_json::json!({
                "pageIndex": res.page_index,
                "pageName": res.page_name,
                "widthBefore": res.width_before,
                "heightBefore": res.height_before,
                "widthAfter": res.width_after,
                "heightAfter": res.height_after,
                "engine": res.engine,
                "beforeBytesApprox": res.before_data_url.len(),
                "afterBytesApprox": res.after_data_url.len(),
            });
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        Commands::Doctor => {
            let report = sched.doctor().await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Commands::ExportDiagnostics { output } => {
            let path = sched.export_diagnostics(output).await?;
            println!("{}", path.display());
        }
        Commands::ListGpus => {
            let gpus = sched.engine().list_gpus().await?;
            println!("{}", serde_json::to_string_pretty(&gpus)?);
        }
        Commands::ClearJobs => {
            let n = sched.clear_finished_jobs().await?;
            println!("{{\"removed\":{n}}}");
        }
        Commands::Run {
            input,
            output,
            preset,
            scale,
            container,
            format,
            jpeg_quality,
        } => {
            std::fs::create_dir_all(&output)?;
            if let Some(hint) = sched.probe_resume(&input.display().to_string()).await? {
                eprintln!("{}", hint.message);
            }
            let created = sched
                .create_job(CreateJobRequest {
                    source: input.display().to_string(),
                    engine: Some("waifu2x".into()),
                    preset,
                    output: OutputOptionsDto {
                        dir: output.display().to_string(),
                        container,
                        image_format: format,
                        jpeg_quality: Some(jpeg_quality),
                        webp_quality: None,
                        naming: None,
                    },
                    enhance: EnhanceDto {
                        scale: Some(scale),
                        ..Default::default()
                    },
                })
                .await?;
            let id = created.job_id;
            if created.resumed {
                eprintln!(
                    "resumed from page {} ({}/{})",
                    created.next_page, created.pages_done, created.pages_total
                );
            }
            eprintln!("job_id={id}");
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let s = sched.get_job(&id).await?;
                eprint!(
                    "\rstate={:?} {}/{}   ",
                    s.state, s.pages_done, s.pages_total
                );
                if matches!(
                    s.state,
                    JobState::Completed | JobState::Failed | JobState::Cancelled
                ) {
                    eprintln!();
                    println!("{}", serde_json::to_string_pretty(&s)?);
                    if s.state != JobState::Completed {
                        std::process::exit(1);
                    }
                    break;
                }
            }
        }
    }
    Ok(())
}

fn save_data_url(data_url: &str, path: &std::path::Path) -> anyhow::Result<()> {
    let b64 = data_url
        .split_once(',')
        .map(|(_, b)| b)
        .ok_or_else(|| anyhow::anyhow!("invalid data url"))?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
    std::fs::write(path, bytes)?;
    Ok(())
}
