use agent_browser_bridge::rpc::{parse_envelope, ErrorCode, Envelope};
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
fn every_valid_fixture_round_trips() {
    let dir = repo_root().join("protocol/fixtures");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".json") || name == "tools-list.json" || name.starts_with("res-unknown-version") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let env = parse_envelope(&text).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let back: serde_json::Value = serde_json::to_value(&env).unwrap();
        let orig: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, orig, "{name} must round-trip unchanged");
    }
}

#[test]
fn unknown_version_is_rejected_with_specific_code() {
    let text = std::fs::read_to_string(repo_root().join("protocol/fixtures/res-unknown-version.json")).unwrap();
    let err = parse_envelope(&text).unwrap_err();
    assert_eq!(err.code, ErrorCode::ProtocolVersionUnsupported);
}

#[test]
fn error_codes_match_ledger() {
    let ledger: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(repo_root().join("protocol/schema/error-codes.json")).unwrap(),
    )
    .unwrap();
    let ours: Vec<String> = ErrorCode::ALL
        .iter()
        .map(|c| serde_json::to_value(c).unwrap().as_str().unwrap().to_string())
        .collect();
    assert_eq!(ours, ledger);
}

#[test]
fn request_constructor_uses_unique_ids() {
    let a = Envelope::req("x", serde_json::json!({}));
    let b = Envelope::req("x", serde_json::json!({}));
    assert_ne!(a.id(), b.id());
}
