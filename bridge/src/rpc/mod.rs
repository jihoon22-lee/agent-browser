use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BrowserDisconnected, TabNotFound, TabClosed, UnsupportedPage, FrameUnavailable,
    StaleElement, ElementNotFound, ElementNotInteractable, Timeout, Cancelled,
    BrowserBusy, ExecutionUnknown, NeedsTabActivation, OperationRequired, OperationInvalid,
    InvalidParams, AuthRequired, AuthFailed, NotPaired, ForbiddenMethod,
    ProtocolVersionUnsupported, Internal,
}

impl ErrorCode {
    pub const ALL: &'static [ErrorCode] = &[
        Self::BrowserDisconnected, Self::TabNotFound, Self::TabClosed, Self::UnsupportedPage,
        Self::FrameUnavailable, Self::StaleElement, Self::ElementNotFound,
        Self::ElementNotInteractable, Self::Timeout, Self::Cancelled, Self::BrowserBusy,
        Self::ExecutionUnknown, Self::NeedsTabActivation, Self::OperationRequired,
        Self::OperationInvalid, Self::InvalidParams, Self::AuthRequired, Self::AuthFailed,
        Self::NotPaired, Self::ForbiddenMethod, Self::ProtocolVersionUnsupported, Self::Internal,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Retry { Safe, Unsafe, Never }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retry: Retry,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

impl RpcError {
    pub fn new(code: ErrorCode, retry: Retry, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retry, details: Value::Null }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Envelope {
    Req { v: u32, id: String, method: String, params: Value },
    Res {
        v: u32,
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Evt { v: u32, event: String, data: Value },
}

impl Envelope {
    pub fn req(method: impl Into<String>, params: Value) -> Self {
        Self::Req { v: PROTOCOL_VERSION, id: format!("req-{}", uuid::Uuid::new_v4()), method: method.into(), params }
    }
    pub fn ok(id: impl Into<String>, result: Value) -> Self {
        Self::Res { v: PROTOCOL_VERSION, id: id.into(), ok: true, result: Some(result), error: None }
    }
    pub fn err(id: impl Into<String>, error: RpcError) -> Self {
        Self::Res { v: PROTOCOL_VERSION, id: id.into(), ok: false, result: None, error: Some(error) }
    }
    pub fn evt(event: impl Into<String>, data: Value) -> Self {
        Self::Evt { v: PROTOCOL_VERSION, event: event.into(), data }
    }
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Req { id, .. } | Self::Res { id, .. } => Some(id),
            Self::Evt { .. } => None,
        }
    }
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("envelope serializes")
    }
}

pub fn parse_envelope(text: &str) -> Result<Envelope, RpcError> {
    let raw: Value = serde_json::from_str(text)
        .map_err(|e| RpcError::new(ErrorCode::InvalidParams, Retry::Never, format!("invalid JSON: {e}")))?;
    let v = raw.get("v").and_then(Value::as_u64);
    if v != Some(PROTOCOL_VERSION as u64) {
        return Err(RpcError::new(
            ErrorCode::ProtocolVersionUnsupported,
            Retry::Never,
            format!("protocol version {v:?} is not supported; this bridge speaks v{PROTOCOL_VERSION}"),
        ));
    }
    serde_json::from_value(raw)
        .map_err(|e| RpcError::new(ErrorCode::InvalidParams, Retry::Never, format!("invalid envelope: {e}")))
}
