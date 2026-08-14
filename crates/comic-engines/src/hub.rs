//! Multi-engine catalog: pick per job without restarting the app.

use crate::{
    resolve_realcugan_paths, resolve_waifu2x_paths, EngineAvailability, EngineKind, EngineStatus,
    MockEngine, RealCuganEngine, UpscaleEngine, Waifu2xEngine,
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
                realcugan: None,
                allow_mock: true,
            };
        }
        let waifu2x = resolve_waifu2x_paths(waifu2x_bin, waifu2x_models).and_then(|p| {
            let eng = Waifu2xEngine::new(p.binary, p.models_dir);
            match eng.is_available() {
                EngineAvailability::Ready => Some(Arc::new(eng)),
                _ => None,
            }
        });
        let realcugan = resolve_realcugan_paths().and_then(|p| {
            let eng = RealCuganEngine::new(p.binary, p.models_root);
            match eng.is_available() {
                EngineAvailability::Ready => Some(Arc::new(eng)),
                _ => None,
            }
        });
        Self {
            mock: Arc::new(MockEngine::default()),
            waifu2x,
            realcugan,
            allow_mock,
        }
    }

    pub fn default_kind(&self) -> EngineKind {
        if self.realcugan.is_some() {
            EngineKind::RealCugan
        } else if self.waifu2x.is_some() {
            EngineKind::Waifu2x
        } else {
            EngineKind::RealCugan
        }
    }

    pub fn pick(&self, kind: EngineKind) -> Result<Arc<dyn UpscaleEngine>, String> {
        match kind {
            EngineKind::Waifu2x => {
                if let Some(e) = &self.waifu2x {
                    return Ok(e.clone());
                }
                if self.allow_mock {
                    return Ok(self.mock.clone());
                }
                Err("Waifu2x 引擎不可用".into())
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
        let w_ok = self.waifu2x.is_some() || self.allow_mock;
        out.push(EngineInfo {
            id: "waifu2x".into(),
            label: "Waifu2x（稳妥 / 去噪）".into(),
            available: w_ok,
            detail: self.status_for(EngineKind::Waifu2x).detail,
            scales: vec![1, 2],
            models: vec![EngineModelInfo {
                id: "cunet".into(),
                label: "CUnet".into(),
            }],
        });
        let c_ok = self.realcugan.is_some();
        let packs = self
            .realcugan
            .as_ref()
            .map(|e| {
                e.available_packs()
                    .into_iter()
                    .map(|p| EngineModelInfo {
                        id: p.id().into(),
                        label: match p {
                            crate::CuganModelPack::Se => "SE（推荐 / 护网点）".into(),
                            crate::CuganModelPack::Pro => "PRO（更高质量）".into(),
                            crate::CuganModelPack::Nose => "NOSE（更快）".into(),
                        },
                    })
                    .collect()
            })
            .unwrap_or_else(|| {
                vec![EngineModelInfo {
                    id: "se".into(),
                    label: "SE".into(),
                }]
            });
        out.push(EngineInfo {
            id: "realcugan".into(),
            label: "Real-CUGAN（锐利 / 4×）".into(),
            available: c_ok,
            detail: self.status_for(EngineKind::RealCugan).detail,
            scales: vec![1, 2, 3, 4],
            models: packs,
        });
        out
    }

    pub fn any_real(&self) -> bool {
        self.waifu2x.is_some() || self.realcugan.is_some()
    }
}
