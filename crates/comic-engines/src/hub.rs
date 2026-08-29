//! Multi-engine catalog: pick per job without restarting the app.

use crate::{
    resolve_animevideo_coreml_model, resolve_realcugan_coreml_model, resolve_realcugan_paths,
    resolve_realesrgan_coreml_model, resolve_waifu2x_coreml_model, resolve_waifu2x_paths,
    AnimeVideoCoreMlEngine, EngineAvailability, EngineKind, EngineStatus, MockEngine,
    RealCuganCoreMlEngine, RealCuganEngine, RealEsrganCoreMlEngine, UpscaleEngine,
    Waifu2xCoreMlEngine, Waifu2xEngine,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub detail: String,
    pub scales: Vec<u8>,
    pub models: Vec<EngineModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Clone)]
pub struct EngineHub {
    mock: Arc<MockEngine>,
    waifu2x: Option<Arc<Waifu2xEngine>>,
    waifu2x_coreml: Option<Arc<Waifu2xCoreMlEngine>>,
    realesrgan_coreml: Option<Arc<RealEsrganCoreMlEngine>>,
    realcugan_coreml: Option<Arc<RealCuganCoreMlEngine>>,
    animevideo_coreml: Option<Arc<AnimeVideoCoreMlEngine>>,
    realcugan: Option<Arc<RealCuganEngine>>,
    allow_mock: bool,
}

impl EngineHub {
    pub fn from_config(
        waifu2x_bin: Option<&std::path::Path>,
        waifu2x_models: Option<&std::path::Path>,
        use_mock: bool,
        allow_mock: bool,
    ) -> Self {
        if use_mock {
            return Self {
                mock: Arc::new(MockEngine::default()),
                waifu2x: None,
                waifu2x_coreml: None,
                realesrgan_coreml: None,
                realcugan_coreml: None,
                animevideo_coreml: None,
                realcugan: None,
                allow_mock: true,
            };
        }
        let waifu2x = resolve_waifu2x_paths(waifu2x_bin, waifu2x_models).and_then(|p| {
            let mut eng = Waifu2xEngine::new(p.binary, p.models_dir);
            // 接线 checksums.sha256 完整性校验（此前 expected_sha256 恒为 None，形同虚设）
            eng.expected_sha256 = crate::paths::expected_binary_sha256(
                &p.third_party,
                "waifu2x-ncnn-vulkan",
                crate::paths::binary_name(),
            );
            match eng.is_available() {
                EngineAvailability::Ready => Some(Arc::new(eng)),
                _ => None,
            }
        });
        let waifu2x_coreml =
            resolve_waifu2x_coreml_model().map(|p| Arc::new(Waifu2xCoreMlEngine::new(p)));
        let realesrgan_coreml =
            resolve_realesrgan_coreml_model().map(|p| Arc::new(RealEsrganCoreMlEngine::new(p)));
        let realcugan_coreml =
            resolve_realcugan_coreml_model().map(|p| Arc::new(RealCuganCoreMlEngine::new(p)));
        let animevideo_coreml =
            resolve_animevideo_coreml_model().map(|p| Arc::new(AnimeVideoCoreMlEngine::new(p)));
        let realcugan = resolve_realcugan_paths().and_then(|p| {
            let mut eng = RealCuganEngine::new(p.binary, p.models_root);
            eng.expected_sha256 = crate::paths::expected_binary_sha256(
                &p.third_party,
                "realcugan-ncnn-vulkan",
                crate::paths::realcugan_binary_name(),
            );
            match eng.is_available() {
                EngineAvailability::Ready => Some(Arc::new(eng)),
                _ => None,
            }
        });
        Self {
            mock: Arc::new(MockEngine::default()),
            waifu2x,
            waifu2x_coreml,
            realesrgan_coreml,
            realcugan_coreml,
            animevideo_coreml,
            realcugan,
            allow_mock,
        }
    }

    pub fn default_kind(&self) -> EngineKind {
        if self.realcugan_coreml.is_some() {
            EngineKind::RealCuganCoreMl
        } else if self.waifu2x_coreml.is_some() {
            EngineKind::Waifu2xCoreMl
        } else if self.realesrgan_coreml.is_some() {
            EngineKind::RealEsrganCoreMl
        } else {
            EngineKind::RealCuganCoreMl
        }
    }

    pub fn pick(&self, kind: EngineKind) -> Result<Arc<dyn UpscaleEngine>, String> {
        match kind {
            EngineKind::Waifu2xCoreMl => {
                if let Some(e) = &self.waifu2x_coreml {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err("未找到 Waifu2x Core ML 模型，请运行 scripts/fetch-waifu2x-coreml.sh".into())
            }
            EngineKind::Waifu2x => {
                if let Some(e) = &self.waifu2x {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err("Waifu2x 引擎不可用".into())
            }
            EngineKind::RealEsrganCoreMl => {
                if let Some(e) = &self.realesrgan_coreml {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err(
                    "未找到 Real-ESRGAN Core ML 模型，请运行 scripts/fetch-realesrgan-coreml.sh"
                        .into(),
                )
            }
            EngineKind::RealCuganCoreMl => {
                if let Some(e) = &self.realcugan_coreml {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err(
                    "未找到 Real-CUGAN Core ML 模型，请运行 scripts/fetch-realcugan-coreml.sh"
                        .into(),
                )
            }
            EngineKind::AnimeVideoCoreMl => {
                if let Some(e) = &self.animevideo_coreml {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err(
                    "未找到 AnimeVideo Core ML 模型，请运行 scripts/fetch-animevideo-coreml.sh"
                        .into(),
                )
            }
            EngineKind::RealCugan => {
                if let Some(e) = &self.realcugan {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err("Real-CUGAN 未安装，请运行 scripts/fetch-realcugan.sh".into())
            }
            #[cfg(feature = "anime4k")]
            EngineKind::Anime4K2x => Err("Anime4K 尚未接入".into()),
        }
    }

    pub fn status_for(&self, kind: EngineKind) -> EngineStatus {
        match self.pick(kind) {
            Ok(e) => e.status(),
            Err(s) => EngineStatus {
                id: match kind {
                    EngineKind::Waifu2x => "waifu2x".into(),
                    EngineKind::Waifu2xCoreMl => "waifu2x-coreml".into(),
                    EngineKind::RealEsrganCoreMl => "realesrgan-coreml".into(),
                    EngineKind::RealCuganCoreMl => "realcugan-coreml".into(),
                    EngineKind::AnimeVideoCoreMl => "animevideo-coreml".into(),
                    EngineKind::RealCugan => "realcugan".into(),
                    #[cfg(feature = "anime4k")]
                    EngineKind::Anime4K2x => "anime4k".into(),
                },
                available: false,
                detail: s,
                version: None,
            },
        }
    }

    pub fn catalog(&self) -> Vec<EngineInfo> {
        let mut out = Vec::new();
        let cug_cm_ok = self.realcugan_coreml.is_some();
        out.push(EngineInfo {
            id: "realcugan-coreml".into(),
            label: "Real-CUGAN（护网点 / ANE）".into(),
            available: cug_cm_ok,
            detail: self.status_for(EngineKind::RealCuganCoreMl).detail,
            scales: vec![2],
            models: vec![
                EngineModelInfo {
                    id: "n0".into(),
                    label: "保守（护网点）".into(),
                },
                EngineModelInfo {
                    id: "n1".into(),
                    label: "轻度去噪".into(),
                },
                EngineModelInfo {
                    id: "n2".into(),
                    label: "标准去噪".into(),
                },
                EngineModelInfo {
                    id: "n3".into(),
                    label: "强力去噪".into(),
                },
            ],
        });
        let cm_ok = self.waifu2x_coreml.is_some();
        out.push(EngineInfo {
            id: "waifu2x-coreml".into(),
            label: "Waifu2x（去噪 / ANE）".into(),
            available: cm_ok,
            detail: self.status_for(EngineKind::Waifu2xCoreMl).detail,
            scales: vec![2],
            models: vec![
                EngineModelInfo {
                    id: "n0".into(),
                    label: "轻度去噪".into(),
                },
                EngineModelInfo {
                    id: "n2".into(),
                    label: "标准去噪（推荐）".into(),
                },
                EngineModelInfo {
                    id: "n3".into(),
                    label: "强力去噪".into(),
                },
            ],
        });
        let esr_ok = self.realesrgan_coreml.is_some();
        out.push(EngineInfo {
            id: "realesrgan-coreml".into(),
            label: "Real-ESRGAN Anime 4×（更锐 / Core ML）".into(),
            available: esr_ok,
            detail: self.status_for(EngineKind::RealEsrganCoreMl).detail,
            scales: vec![4],
            models: vec![EngineModelInfo {
                id: "anime-6b".into(),
                label: "Anime 6B · 4×".into(),
            }],
        });
        let avd_ok = self.animevideo_coreml.is_some();
        out.push(EngineInfo {
            id: "animevideo-coreml".into(),
            label: "AnimeVideo v3（极速 / ANE）".into(),
            available: avd_ok,
            detail: self.status_for(EngineKind::AnimeVideoCoreMl).detail,
            scales: vec![4],
            models: vec![EngineModelInfo {
                id: "v3-4x".into(),
                label: "Compact · 4×".into(),
            }],
        });
        out
    }

    pub fn any_real(&self) -> bool {
        self.waifu2x.is_some()
            || self.waifu2x_coreml.is_some()
            || self.realesrgan_coreml.is_some()
            || self.realcugan_coreml.is_some()
            || self.animevideo_coreml.is_some()
            || self.realcugan.is_some()
    }
}
