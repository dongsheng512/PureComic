//! Resolve bundled waifu2x binary + models layout under third_party/.

use std::env;
use std::path::{Path, PathBuf};

/// Host triple folder name used under `third_party/waifu2x-ncnn-vulkan/bin/<target>/`.
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

/// Walk up from `start` looking for `third_party/waifu2x-ncnn-vulkan`.
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

/// Candidate roots: env, cwd, executable dir, compile-time CARGO_MANIFEST_DIR chain.
pub fn third_party_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = env::var("COMIC_THIRD_PARTY") {
        out.push(PathBuf::from(p));
    }
    if let Ok(cwd) = env::current_dir() {
        if let Some(tp) = find_third_party_root(&cwd) {
            out.push(tp);
        }
        out.push(cwd.join("third_party"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            // app bundle: Contents/MacOS -> Resources
            out.push(parent.join("third_party"));
            out.push(parent.join("../Resources"));
            out.push(parent.join("../Resources/resources"));
            out.push(parent.join("../Resources/third_party"));
            out.push(parent.join("../../third_party"));
            if let Some(tp) = find_third_party_root(parent) {
                out.push(tp);
            }
        }
    }
    // workspace relative from this crate at compile time
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // crates/comic-engines -> repo root
    if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
        out.push(root.join("third_party"));
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
                third_party: m
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf(),
            });
        }
    }

    let triple = host_target_triple();
    let bin_name = binary_name();

    for tp in third_party_candidates() {
        if !tp.is_dir() {
            continue;
        }
        let models = first_existing_dir(&[
            tp.join("models-cunet"),
            tp.join("resources/models-cunet"),
        ])
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

fn first_existing_dir(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_dir()).cloned()
}

#[derive(Debug, Clone)]
pub struct RealCuganPaths {
    pub binary: PathBuf,
    pub models_root: PathBuf,
}

pub fn resolve_realcugan_paths() -> Option<RealCuganPaths> {
    let triple = host_target_triple();
    let bin_name = realcugan_binary_name();
    for tp in third_party_candidates() {
        if !tp.is_dir() {
            continue;
        }
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

/// Read expected sha256 for host binary from third_party/checksums.sha256 if present.
pub fn expected_binary_sha256(third_party: &Path) -> Option<String> {
    let file = third_party.join("checksums.sha256");
    let text = std::fs::read_to_string(file).ok()?;
    let triple = host_target_triple();
    let bin_name = binary_name();
    let needle = format!("waifu2x-ncnn-vulkan/bin/{triple}/{bin_name}");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let path = parts.next()?;
        if path == needle
            || path.ends_with(bin_name)
            || (path.ends_with(&format!("/{bin_name}")) && path.contains(triple))
        {
            return Some(sum.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triple_non_empty() {
        assert!(!host_target_triple().is_empty());
    }
}
