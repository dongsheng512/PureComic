//! Resolve engine binaries + models under `third_party/` (Core ML) and
//! `third_party/ncnn-vulkan/` (optional Waifu2x / Real-CUGAN sidecars).

use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 打包版（.app/MSI）由宿主进程在 setup 时显式指认的资源根目录。
/// 之所以不用环境变量传递：release 下环境可被启动环境注入，等价于允许
/// 从任意目录加载未校验的引擎/模型；进程内 OnceLock 只能由本程序设置。
static PACKAGED_THIRD_PARTY: OnceLock<PathBuf> = OnceLock::new();

/// 宿主（桌面端）在 setup 阶段调用，优先级最高的 third_party 根目录。
pub fn set_packaged_third_party(root: impl Into<PathBuf>) {
    let _ = PACKAGED_THIRD_PARTY.set(root.into());
}

/// Host triple folder name used under `ncnn-vulkan/waifu2x-ncnn-vulkan/bin/<target>/`.
pub fn host_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "unknown"
    }
}

pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "waifu2x-ncnn-vulkan.exe"
    } else {
        "waifu2x-ncnn-vulkan"
    }
}

pub fn realcugan_binary_name() -> &'static str {
    if cfg!(windows) {
        "realcugan-ncnn-vulkan.exe"
    } else {
        "realcugan-ncnn-vulkan"
    }
}

/// Walk up from `start` looking for `third_party/`.
pub fn find_third_party_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        let candidate = dir.join("third_party");
        if candidate.is_dir() {
            return Some(candidate);
        }
        cur = dir.parent();
    }
    None
}

/// Candidate roots: env, packaged resources, cwd (debug only), exe dir, repo root.
/// Release 构建禁止从 cwd 向上遍历找 third_party —— 否则可从任意工作目录
/// 启动时注入替换过的引擎二进制（配合 checksums 校验才是完整的防线）。
pub fn third_party_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = PACKAGED_THIRD_PARTY.get() {
        out.push(p.clone());
    }
    // 环境变量仅限 debug/test（对齐 config.rs 对 COMIC_WAIFU2X_BIN 的处理）：
    // release 下启动环境可注入未校验的引擎与模型目录
    #[cfg(any(debug_assertions, test))]
    if let Ok(p) = env::var("COMIC_THIRD_PARTY") {
        out.push(PathBuf::from(p));
    }
    // 打包资源优先
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            // app bundle: Contents/MacOS -> Resources
            out.push(parent.join("third_party"));
            out.push(parent.join("../Resources"));
            out.push(parent.join("../Resources/resources"));
            out.push(parent.join("../Resources/third_party"));
            out.push(parent.join("../../third_party"));
        }
    }
    if cfg!(debug_assertions) {
        // 开发便利：允许 cwd 下的 third_party（仅 debug 构建）
        if let Ok(cwd) = env::current_dir() {
            if let Some(tp) = find_third_party_root(&cwd) {
                out.push(tp);
            }
            out.push(cwd.join("third_party"));
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(tp) = find_third_party_root(parent) {
                out.push(tp);
            }
        }
    }
    // workspace relative from this crate at compile time — dev only, so a
    // release binary never trusts a repo checkout on the machine that built it
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // crates/comic-engines -> repo root
        if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
            out.push(root.join("third_party"));
        }
    }
    out
}

/// Vulkan sidecars live in `third_party/ncnn-vulkan/`; keep the old flat
/// `third_party/` layout as a fallback for leftover local checkouts.
fn vulkan_data_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for tp in third_party_candidates() {
        if !tp.is_dir() {
            continue;
        }
        let nested = tp.join("ncnn-vulkan");
        if nested.is_dir() {
            out.push(nested);
        }
        out.push(tp);
    }
    out
}

#[derive(Debug, Clone)]
pub struct Waifu2xPaths {
    pub binary: PathBuf,
    pub models_dir: PathBuf,
    pub third_party: PathBuf,
}

/// Resolve first existing binary + models-cunet pair.
pub fn resolve_waifu2x_paths(
    binary_override: Option<&Path>,
    models_override: Option<&Path>,
) -> Option<Waifu2xPaths> {
    if let (Some(b), Some(m)) = (binary_override, models_override) {
        if b.is_file() && m.is_dir() {
            return Some(Waifu2xPaths {
                binary: b.to_path_buf(),
                models_dir: m.to_path_buf(),
                third_party: m.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
            });
        }
    }

    let triple = host_target_triple();
    let bin_name = binary_name();

    for tp in vulkan_data_roots() {
        let models =
            first_existing_dir(&[tp.join("models-cunet"), tp.join("resources/models-cunet")])
                .or_else(|| {
                    models_override
                        .filter(|m| m.is_dir())
                        .map(|m| m.to_path_buf())
                });
        let Some(models) = models else {
            continue;
        };
        for binary in sidecar_candidates(&tp, triple, bin_name) {
            if binary.is_file() {
                return Some(Waifu2xPaths {
                    binary,
                    models_dir: models,
                    third_party: tp,
                });
            }
        }
    }
    None
}

fn waifu2x_coreml_roots() -> Vec<PathBuf> {
    let dirs = {
        let mut dirs = third_party_candidates();
        // 与 third_party_candidates 对齐：release 禁止从 cwd 加载模型（模型等同可执行代码）
        #[cfg(debug_assertions)]
        dirs.insert(0, PathBuf::from("third_party"));
        dirs
    };
    let mut roots = Vec::new();
    for tp in dirs {
        roots.push(tp.join("waifu2x-coreml"));
        roots.push(tp.join("resources/waifu2x-coreml"));
        roots.push(tp);
    }
    roots
}

fn coreml_names_for_noise(noise: i8) -> [&'static str; 2] {
    match noise {
        3 => [
            "up_anime_noise3_scale2x_model.mlmodelc",
            "up_anime_noise3_scale2x_model.mlmodel",
        ],
        2 => [
            "up_anime_noise2_scale2x_model.mlmodelc",
            "up_anime_noise2_scale2x_model.mlmodel",
        ],
        1 => [
            "up_anime_noise1_scale2x_model.mlmodelc",
            "up_anime_noise1_scale2x_model.mlmodel",
        ],
        _ => [
            "up_anime_noise0_scale2x_model.mlmodelc",
            "up_anime_noise0_scale2x_model.mlmodel",
        ],
    }
}

fn find_coreml_named(names: &[&str]) -> Option<PathBuf> {
    for root in waifu2x_coreml_roots() {
        for name in names {
            let p = root.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Prefer the requested denoise level, then fall back 2 → 1 → 0 → 3.
pub fn resolve_waifu2x_coreml_model_for_noise(noise: i8) -> Option<PathBuf> {
    let want = if (-1..=3).contains(&noise) {
        noise.max(0)
    } else {
        2
    };
    let mut order = vec![want, 2, 1, 0, 3];
    order.dedup();
    for n in order {
        if let Some(p) = find_coreml_named(&coreml_names_for_noise(n)) {
            return Some(p);
        }
    }
    None
}

/// Any installed Core ML waifu2x model (prefers noise2).
/// 注意：Core ML 模型当前只查存在性、未做哈希校验（pin 覆盖 zip 而非 .mlmodelc）。
pub fn resolve_waifu2x_coreml_model() -> Option<PathBuf> {
    resolve_waifu2x_coreml_model_for_noise(2)
}

/// Real-ESRGAN Anime 4× Core ML (`RealESRGAN_x4plus_anime_6B`)。未做哈希校验，同上。
pub fn resolve_realesrgan_coreml_model() -> Option<PathBuf> {
    const NAMES: &[&str] = &[
        "RealESRGAN_x4plus_anime_6B.mlmodelc",
        "RealESRGAN_x4plus_anime_6B.mlmodel",
        "realesrgan_anime4x.mlmodelc",
        "realesrgan_anime4x.mlmodel",
    ];
    let dirs = {
        let mut dirs = third_party_candidates();
        #[cfg(debug_assertions)]
        dirs.insert(0, PathBuf::from("third_party"));
        dirs
    };
    for tp in dirs {
        for root in [
            tp.join("realesrgan-coreml"),
            tp.join("resources/realesrgan-coreml"),
            tp.clone(),
        ] {
            for name in NAMES {
                let p = root.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn realcugan_coreml_roots() -> Vec<PathBuf> {
    let dirs = {
        let mut dirs = third_party_candidates();
        #[cfg(debug_assertions)]
        dirs.insert(0, PathBuf::from("third_party"));
        dirs
    };
    let mut roots = Vec::new();
    for tp in dirs {
        roots.push(tp.join("realcugan-coreml"));
        roots.push(tp.join("resources/realcugan-coreml"));
        roots.push(tp);
    }
    roots
}

fn cugan_coreml_names_for_noise(noise: i8) -> [&'static str; 2] {
    match noise {
        3 => ["up2x_denoise3x.mlpackage", "up2x_denoise3x.mlmodelc"],
        2 => ["up2x_denoise2x.mlpackage", "up2x_denoise2x.mlmodelc"],
        1 => ["up2x_denoise1x.mlpackage", "up2x_denoise1x.mlmodelc"],
        _ => ["up2x_conservative.mlpackage", "up2x_conservative.mlmodelc"],
    }
}

fn find_cugan_coreml_named(names: &[&str]) -> Option<PathBuf> {
    for root in realcugan_coreml_roots() {
        for name in names {
            let p = root.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Reader noise 0=conservative, 1=denoise1x, 2=denoise2x, 3=denoise3x.
pub fn resolve_realcugan_coreml_model_for_noise(noise: i8) -> Option<PathBuf> {
    let want = if (-1..=3).contains(&noise) {
        noise.max(0)
    } else {
        0
    };
    let mut order = vec![want, 0, 1, 2, 3];
    order.dedup();
    for n in order {
        if let Some(p) = find_cugan_coreml_named(&cugan_coreml_names_for_noise(n)) {
            return Some(p);
        }
    }
    None
}

pub fn resolve_realcugan_coreml_model() -> Option<PathBuf> {
    resolve_realcugan_coreml_model_for_noise(0)
}

fn animevideo_coreml_roots() -> Vec<PathBuf> {
    let dirs = {
        let mut dirs = third_party_candidates();
        #[cfg(debug_assertions)]
        dirs.insert(0, PathBuf::from("third_party"));
        dirs
    };
    let mut roots = Vec::new();
    for tp in dirs {
        roots.push(tp.join("animevideo-coreml"));
        roots.push(tp.join("resources/animevideo-coreml"));
    }
    roots
}

/// If `{model}.sha256` exists, every listed file must match.
/// Missing pin keeps the old existence-only check.
pub fn verify_optional_model_pin(model: &Path) -> Result<(), String> {
    let mut name = model.as_os_str().to_os_string();
    name.push(".sha256");
    let pin = PathBuf::from(name);
    if !pin.is_file() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&pin).map_err(|e| format!("读取模型清单失败: {e}"))?;
    let base = if model.is_dir() {
        model.to_path_buf()
    } else {
        model
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    };
    let mut any = false;
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        any = true;
        let mut parts = line.split_whitespace();
        let hex = parts
            .next()
            .ok_or_else(|| format!("模型清单第 {} 行缺少摘要", n + 1))?;
        let rel = parts
            .next()
            .ok_or_else(|| format!("模型清单第 {} 行缺少路径", n + 1))?;
        if parts.next().is_some() || rel.split(['/', '\\']).any(|p| p == "..") {
            return Err(format!("模型清单第 {} 行路径无效", n + 1));
        }
        let file = base.join(rel);
        crate::verify_sha256(&file, hex).map_err(|_| format!("模型校验失败: {rel}"))?;
    }
    if !any {
        return Err("模型校验清单为空".into());
    }
    Ok(())
}

/// realesr-animevideov3 4×（fp16 mlprogram）。编译缓存目录名带 .i532 后缀，
/// 一并接受以便转换后未清理时仍可解析。
pub fn resolve_animevideo_coreml_model() -> Option<PathBuf> {
    const NAMES: [&str; 3] = [
        "realesr_animevideov3_x4.mlpackage",
        "realesr_animevideov3_x4.mlpackage.i532.mlmodelc",
        "realesr_animevideov3_x4.mlmodelc",
    ];
    for root in animevideo_coreml_roots() {
        for name in NAMES {
            let p = root.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn first_existing_dir(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_dir()).cloned()
}

#[derive(Debug, Clone)]
pub struct RealCuganPaths {
    pub binary: PathBuf,
    pub models_root: PathBuf,
    pub third_party: PathBuf,
}

pub fn resolve_realcugan_paths() -> Option<RealCuganPaths> {
    let triple = host_target_triple();
    let bin_name = realcugan_binary_name();
    for tp in vulkan_data_roots() {
        let root = tp.join("realcugan-ncnn-vulkan");
        let models_root = if root.join("models-se").is_dir() || root.join("models-pro").is_dir() {
            root.clone()
        } else if tp.join("models-se").is_dir() {
            tp.clone()
        } else {
            continue;
        };
        let bins = [
            root.join("bin").join(triple).join(bin_name),
            tp.join(bin_name),
            tp.join(format!("PureComic-{bin_name}")),
            tp.join(format!("purecomic-{bin_name}")),
            tp.join(format!("comic-enhance-desktop-{bin_name}")),
            tp.parent()
                .unwrap_or(tp.as_path())
                .join("MacOS")
                .join(bin_name),
        ];
        for binary in bins {
            if binary.is_file() {
                return Some(RealCuganPaths {
                    binary,
                    models_root,
                    third_party: tp,
                });
            }
        }
    }
    None
}

fn sidecar_candidates(tp: &Path, triple: &str, bin_name: &str) -> Vec<PathBuf> {
    let macos = tp.parent().unwrap_or(tp).join("MacOS");
    vec![
        tp.join("waifu2x-ncnn-vulkan")
            .join("bin")
            .join(triple)
            .join(bin_name),
        tp.join(bin_name),
        tp.join(format!("PureComic-{bin_name}")),
        tp.join(format!("purecomic-{bin_name}")),
        tp.join(format!("comic-enhance-desktop-{bin_name}")),
        macos.join(bin_name),
        macos.join(format!("PureComic-{bin_name}")),
        macos.join(format!("purecomic-{bin_name}")),
        macos.join(format!("comic-enhance-desktop-{bin_name}")),
    ]
}

/// 编译期嵌入的官方校验和（仓库内 pin 文件）：env 指向目录里的同名文件
/// 可被攻击者一并替换，完整性基线必须来自二进制自身。
const EMBEDDED_CHECKSUMS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../third_party/ncnn-vulkan/checksums.sha256"
));

fn sha_for_host_binary(text: &str, engine_dir: &str, bin_name: &str) -> Option<String> {
    let triple = host_target_triple();
    let needle = format!("{engine_dir}/bin/{triple}/{bin_name}");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let path = parts.next()?;
        // 只接受本 host triple 的精确路径，避免匹配到其它平台的同名行
        if path == needle || path.ends_with(&format!("/{triple}/{bin_name}")) {
            return Some(sum.to_string());
        }
    }
    None
}

/// Expected sha256 for host binary：优先编译期嵌入的官方 pin，
/// 其次 sidecar 目录里的 `checksums.sha256`（兼容本地 fetch 流程）。
pub fn expected_binary_sha256(
    third_party: &Path,
    engine_dir: &str,
    bin_name: &str,
) -> Option<String> {
    if let Some(sum) = sha_for_host_binary(EMBEDDED_CHECKSUMS, engine_dir, bin_name) {
        return Some(sum);
    }
    let file = [
        third_party.join("checksums.sha256"),
        third_party.join("ncnn-vulkan/checksums.sha256"),
    ]
    .into_iter()
    .find(|p| p.is_file())?;
    let text = std::fs::read_to_string(file).ok()?;
    sha_for_host_binary(&text, engine_dir, bin_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_pin_rejects_changed_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("weights.bin");
        std::fs::write(&model, b"hello").unwrap();
        let pin = dir.path().join("weights.bin.sha256");
        std::fs::write(
            &pin,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  weights.bin\n",
        )
        .unwrap();
        assert!(verify_optional_model_pin(&model).is_ok());
        std::fs::write(&model, b"hellp").unwrap();
        assert!(verify_optional_model_pin(&model).is_err());
    }

    #[test]
    fn model_without_pin_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("weights.bin");
        std::fs::write(&model, b"hello").unwrap();
        assert!(verify_optional_model_pin(&model).is_ok());
    }

    #[test]
    fn triple_non_empty() {
        assert!(!host_target_triple().is_empty());
    }

    #[test]
    fn sha_parser_matches_engine_specific_line() {
        let t = host_target_triple();
        let text = format!(
            "aaaa  waifu2x-ncnn-vulkan/bin/{t}/waifu2x-ncnn-vulkan\n\
             bbbb  realcugan-ncnn-vulkan/bin/{t}/realcugan-ncnn-vulkan\n"
        );
        assert_eq!(
            sha_for_host_binary(&text, "waifu2x-ncnn-vulkan", binary_name()).as_deref(),
            Some("aaaa")
        );
        assert_eq!(
            sha_for_host_binary(&text, "realcugan-ncnn-vulkan", realcugan_binary_name()).as_deref(),
            Some("bbbb")
        );
    }
}
