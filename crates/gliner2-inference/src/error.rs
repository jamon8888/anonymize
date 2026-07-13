use std::fmt;

#[derive(Debug)]
pub enum GlinerError {
    OomDeviceBinding(String),
    OomDeviceStandard(String),
    OomHostRam(String),
    BindingNotSupported(String),
    TensorShapeMismatch(String),
    Other(anyhow::Error),
}

impl fmt::Display for GlinerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OomDeviceBinding(m) => write!(f, "[E_GLI_001] OOM_DEVICE_BINDING: {}", m),
            Self::OomDeviceStandard(m) => write!(f, "[E_GLI_002] OOM_DEVICE_STANDARD: {}", m),
            Self::OomHostRam(m) => write!(f, "[E_GLI_003] OOM_HOST_RAM: {}", m),
            Self::BindingNotSupported(m) => write!(f, "[E_GLI_004] BINDING_NOT_SUPPORTED: {}", m),
            Self::TensorShapeMismatch(m) => write!(f, "[E_GLI_005] TENSOR_SHAPE_MISMATCH: {}", m),
            Self::Other(err) => write!(f, "{}", err),
        }
    }
}

impl std::error::Error for GlinerError {}

impl From<anyhow::Error> for GlinerError {
    fn from(err: anyhow::Error) -> Self {
        GlinerError::Other(err)
    }
}
