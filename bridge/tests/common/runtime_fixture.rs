//! Failure evidence for the synthetic Linux runtime fixture. Never serialize the
//! private runtime.json wholesale: it contains managed authentication credentials.
use agent_browser_bridge::rpc::RpcError;
use serde_json::{json,Value};
use std::path::Path;

pub fn summary(value: &Value) -> Value {
    json!({"profileId":value["profileId"],"state":value["state"],"owned":value["owned"],"baseUrl":value["baseUrl"],"error":value["error"]})
}

pub fn outcome(value: Result<Result<Value,RpcError>,tokio::task::JoinError>) -> Value {
    match value { Ok(Ok(value)) => value, Ok(Err(error)) => json!({"state":"error","error":error.message}), Err(error) => json!({"state":"error","error":format!("startup task failed: {error}")}) }
}

pub fn diagnostics(home: &Path) -> Value {
    let config: Value = std::fs::read(home.join("runtime.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let mut runtimes = Vec::new();
    if let Some(records) = config["runtimes"].as_object() {
        for (id,record) in records {
            let pid = record["launcher"]["pid"].as_u64().unwrap_or(0);
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
            let fields: Vec<_> = stat.as_deref().and_then(|stat| stat.rsplit_once(')')).map(|(_,rest)| rest.split_whitespace().collect()).unwrap_or_default();
            let image = std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|path| path.to_string_lossy().into_owned());
            let ticks = fields.get(19).and_then(|ticks| ticks.parse::<u64>().ok());
            let state = fields.first().copied().unwrap_or("missing");
            runtimes.push(json!({"profileId":id,"baseUrl":record["baseUrl"],"version":record["version"],"pid":pid,"processState":state,
                "expectedImage":record["launcher"]["image"],"actualImage":image,"expectedStartTicks":record["launcher"]["created"],"actualStartTicks":ticks,
                "ownerMatches":ticks == record["launcher"]["created"].as_u64() && image.as_deref() == record["launcher"]["image"].as_str()}));
        }
    }
    let events: Vec<_> = ["first","second"].into_iter().map(|id| {
        let text = std::fs::read_to_string(home.join(format!("{id}.jsonl"))).unwrap_or_default();
        let entries: Vec<Value> = text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
        let tail = entries.len().saturating_sub(40);
        json!({"profileId":id,"eventCount":entries.len(),"events":&entries[tail..]})
    }).collect();
    json!({"runtimes":runtimes,"fixtures":events})
}

pub fn startup_failure(evidence: &Value) -> Option<String> {
    let runtimes = evidence["runtimes"].as_array()?;
    if runtimes.len() == 2 && runtimes[0]["baseUrl"] == runtimes[1]["baseUrl"] { return Some("Concurrent profiles reserved the same port before their delayed listeners bound".into()); }
    for runtime in runtimes {
        if matches!(runtime["processState"].as_str(),Some("missing"|"Z")) { return Some(format!("Synthetic runtime {} exited during startup",runtime["profileId"])); }
        if runtime["ownerMatches"] == false { return Some(format!("Synthetic runtime {} changed its recorded process identity",runtime["profileId"])); }
    }
    for fixture in evidence["fixtures"].as_array()? {
        for event in fixture["events"].as_array()? {
            if matches!(event["event"].as_str(),Some("listen-error"|"uncaught-exception"|"unhandled-rejection")) { return Some(format!("Synthetic runtime {} failed: {}",fixture["profileId"],event["code"])); }
        }
    }
    None
}

pub fn fail(reason: &str, evidence: Value) -> ! {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/.artifacts");
    let artifact = directory.join(format!("runtime-fixture-failure-{}.json",std::process::id()));
    let text = serde_json::to_string_pretty(&json!({"reason":reason,"evidence":evidence})).unwrap();
    let written = std::fs::create_dir_all(directory).and_then(|_| std::fs::write(&artifact,&text)).is_ok();
    panic!("{reason}\n{evidence}\nartifact: {}",if written {artifact.display().to_string()} else {"could not write diagnostic artifact".into()});
}
