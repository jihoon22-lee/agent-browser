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
    let raw: Value = match serde_json::from_str(text) {
        Ok(raw) => raw,
        // Page text cut inside an emoji arrives as a lone surrogate escape, which JSON.stringify
        // emits and serde_json refuses. Read it as U+FFFD instead of losing the whole reply.
        Err(e) => replace_lone_surrogates(text).and_then(|fixed| serde_json::from_str(&fixed).ok())
            .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, Retry::Never, format!("invalid JSON: {e}")))?,
    };
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

/// `\uD800`-`\uDFFF` escapes that are not a high+low pair become `�`. A backslash only occurs
/// inside JSON strings, and an escaped backslash is skipped as a pair, so `\\ud83d` stays text.
/// `None` when nothing needed replacing.
fn replace_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let unit = |at: usize| -> Option<u32> {
        if b.get(at) != Some(&b'\\') || b.get(at + 1) != Some(&b'u') { return None; }
        let hex = b.get(at + 2..at + 6).filter(|h| h.iter().all(u8::is_ascii_hexdigit))?;
        u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
    };
    let (mut out, mut copied, mut i) = (String::new(), 0, 0);
    while i < b.len() {
        if b[i] != b'\\' { i += 1; continue; }
        match unit(i) {
            Some(0xD800..=0xDBFF) if matches!(unit(i + 6), Some(0xDC00..=0xDFFF)) => i += 12,
            Some(0xD800..=0xDFFF) => { out.push_str(&text[copied..i]); out.push_str("\\ufffd"); i += 6; copied = i; }
            _ => i += 2,
        }
    }
    if copied == 0 { return None; }
    out.push_str(&text[copied..]);
    Some(out)
}

/// The `id` of a frame that says it is a response, read even when the frame cannot be parsed
/// (broken escape, truncated or malformed result), so its waiting command can be failed at once.
pub fn response_id_of_unreadable(text: &str) -> Option<String> {
    let (kind, id) = match serde_json::from_str::<Value>(text) {
        Ok(raw) => (raw["type"].as_str().map(str::to_string), raw["id"].as_str().map(str::to_string)),
        Err(_) => top_level_type_and_id(text),
    };
    id.filter(|id| kind.as_deref() == Some("res") && !id.is_empty() && id.len() <= 128 && !id.contains('\\'))
}

/// Top-level `"type"` and `"id"` string members of a possibly invalid JSON object.
fn top_level_type_and_id(text: &str) -> (Option<String>, Option<String>) {
    let b = text.as_bytes();
    let (mut i, mut depth, mut key, mut kind, mut id) = (0, 0i32, None::<&str>, None, None);
    while i < b.len() {
        match b[i] {
            b'"' => {
                let start = i + 1;
                i += 1;
                while i < b.len() && b[i] != b'"' { i += if b[i] == b'\\' { 2 } else { 1 }; }
                if i >= b.len() { break; }
                // Both ends are ASCII quotes, so the slice is on character boundaries.
                let string = &text[start..i];
                if depth == 1 {
                    let after = b[i + 1..].iter().find(|c| !c.is_ascii_whitespace());
                    if after == Some(&b':') { key = Some(string); } else {
                        match key.take() { Some("type") => kind = Some(string.to_string()), Some("id") => id = Some(string.to_string()), _ => {} }
                    }
                }
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b',' if depth == 1 => key = None,
            _ => {}
        }
        i += 1;
    }
    (kind, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result_text(frame: &str) -> String {
        match parse_envelope(frame).unwrap() { Envelope::Res { result: Some(result), .. } => result["text"].as_str().unwrap().to_string(), other => panic!("{other:?}") }
    }

    #[test]
    fn a_lone_surrogate_escape_is_read_as_the_replacement_character() {
        assert_eq!(result_text(r#"{"v":1,"type":"res","id":"req-1","ok":true,"result":{"text":"xxxx\ud83d"}}"#), "xxxx\u{fffd}");
        assert_eq!(result_text(r#"{"v":1,"type":"res","id":"req-1","ok":true,"result":{"text":"\ude00 tail"}}"#), "\u{fffd} tail");
        assert_eq!(result_text(r#"{"v":1,"type":"res","id":"req-1","ok":true,"result":{"text":"\ud83d😀\uD83Dx"}}"#), "\u{fffd}\u{1f600}\u{fffd}x");
    }

    #[test]
    fn valid_pairs_and_escaped_backslashes_are_left_alone() {
        assert_eq!(replace_lone_surrogates(r#"{"text":"😀 \\ud83d é \n"}"#), None);
        assert_eq!(result_text(r#"{"v":1,"type":"res","id":"req-1","ok":true,"result":{"text":"😀"}}"#), "\u{1f600}");
        // An escaped backslash followed by text that only looks like an escape, next to a real lone surrogate.
        assert_eq!(result_text(r#"{"v":1,"type":"res","id":"req-1","ok":true,"result":{"text":"\\ud83d \\\ud83d \\\\ud83d"}}"#), "\\ud83d \\\u{fffd} \\\\ud83d");
    }

    #[test]
    fn an_unreadable_response_still_names_its_command() {
        assert_eq!(response_id_of_unreadable(r#"{"v":1,"type":"res","id":"req-7","ok":true,"result":{"text":"bad \x escape","id":"inner"}}"#).as_deref(), Some("req-7"));
        assert_eq!(response_id_of_unreadable(r#"{"v":1,"type":"res","ok":true,"result":{"id":"inner","type":"res"},"id":"req-8""#).as_deref(), Some("req-8"));
        assert_eq!(response_id_of_unreadable(r#"{"v":1,"type":"res","id":"req-9","ok":false,"error":{"code":"NOT_A_CODE"}}"#).as_deref(), Some("req-9"));
        assert_eq!(response_id_of_unreadable(r#"{"v":1,"type":"req","id":"req-7","method":"x","params":{"text":"bad \x"}}"#), None, "only responses complete a command");
        assert_eq!(response_id_of_unreadable(r#"{"v":1,"type":"res","result":{"id":"inner"}}"#), None);
        assert_eq!(response_id_of_unreadable("not json"), None);
    }
}
