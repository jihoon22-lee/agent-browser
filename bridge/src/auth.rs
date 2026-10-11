//! Shared v1 mutual authentication. Tokens never appear in WebSocket frames.
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const VERSION: u64 = 1;

pub fn nonce() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub fn valid_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn transcript(side: &str, role: &str, client_id: &str, client_nonce: &str, server_nonce: &str, repair: bool) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        "agent-browser-auth-v1", side, role, client_id, client_nonce, server_nonce, repair
    ])).expect("authentication transcript serializes")
}

pub fn proof(token: &str, transcript: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts any key size");
    mac.update(transcript);
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn verify(token: &str, transcript: &[u8], proof: &str) -> bool {
    if !valid_hex(proof) { return false; }
    let bytes: Vec<u8> = (0..64).step_by(2).map(|i| u8::from_str_radix(&proof[i..i + 2], 16).unwrap()).collect();
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts any key size");
    mac.update(transcript);
    mac.verify_slice(&bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_independent_cross_language_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!("../../protocol/auth-vectors.json")).unwrap();
        for vector in vectors.as_array().unwrap() {
            for side in ["server", "client"] {
                let text = transcript(side, vector["role"].as_str().unwrap(), vector["clientId"].as_str().unwrap(),
                    vector["clientNonce"].as_str().unwrap(), vector["serverNonce"].as_str().unwrap(), vector["repair"].as_bool().unwrap());
                let expected = vector[format!("{side}Proof")].as_str().unwrap();
                assert_eq!(proof(vector["token"].as_str().unwrap(), &text), expected);
                assert!(verify(vector["token"].as_str().unwrap(), &text, expected));
                assert!(!verify("incorrect-token", &text, expected));
            }
        }
    }
}
