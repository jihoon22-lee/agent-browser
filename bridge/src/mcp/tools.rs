use crate::server::registry::CommandClass;
use serde_json::{json, Value};

pub struct ToolDef { pub name: &'static str, pub description: &'static str, pub schema: Value }

fn op() -> Value { json!({"type":"string","description":"operationId returned by browser_tabs action=attach"}) }
fn r#ref() -> Value { json!({"type":"string","description":"Element ref from the latest browser_snapshot, e.g. s3f0e12"}) }

pub fn all() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "browser_tabs", description:
            "List Chrome tabs, attach a tab to start an operation (returns operationId), open a new tab in the operation, switch between the operation's tabs, close the current operation-created tab (never the attached original), or release the operation. After close, switch to a surviving tabId and snapshot. The operation tab stays fixed even if the user looks at another tab.",
            schema: json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","attach","new","switch","close","release"]},
                "tabId":{"type":"integer","description":"For attach (omit to use the user's current tab) and switch"},
                "requestId":{"type":"string","description":"For attach: requestId supplied with the current panel request. Omit tabId to use its captured active tab; an explicit user target takes priority."},
                "url":{"type":"string","description":"For new: http(s) URL to open"},
                "operationId": op()},
                "required":["action"],"additionalProperties":false}) },
        ToolDef { name: "browser_snapshot", description:
            "Read DOM text, elements and tables with refs. Take a fresh snapshot after attach, navigation, tab switch or rerender before writing; identify targets by name/href, never old index. Continue with offset (text), elementOffset or frameOffset from returned cursors.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "maxChars":{"type":"integer","minimum":200,"maximum":20000,"default":4000},
                "offset":{"type":"integer","minimum":0,"default":0},
                "elementOffset":{"type":"integer","minimum":0,"default":0},
                "frameOffset":{"type":"integer","minimum":0,"default":0}},
                "required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_navigate", description: "Go to an http(s) URL, or go back, forward, or reload, in the operation tab. Waits for navigation to complete. For delayed lists use browser_wait for expected text, then browser_snapshot before clicking.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "action":{"type":"string","enum":["goto","back","forward","reload"],"default":"goto"},
                "url":{"type":"string"}},"required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_click", description: "Click an element by ref. Returns whether the URL or page content changed.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref()},"required":["operationId","ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_fill", description: "Replace the value of a text input or textarea by ref. Returns the value read back from the page.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"text":{"type":"string"}},"required":["operationId","ref","text"],"additionalProperties":false}) },
        ToolDef { name: "browser_select", description: "Choose an option in a select (by option value or visible label) or set a checkbox/radio checked state, by ref.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"option":{"type":"string"},"checked":{"type":"boolean"}},"required":["operationId","ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_press", description: "Press a key on the focused element or on ref. Enter in a form field submits the form.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "key":{"type":"string","enum":["Enter","Tab","Escape","Space","Backspace","ArrowUp","ArrowDown"]}},
                "required":["operationId","key"],"additionalProperties":false}) },
        ToolDef { name: "browser_scroll", description: "Scroll the page or a scrollable element (ref).",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "direction":{"type":"string","enum":["up","down","top","bottom"]}},"required":["operationId","direction"],"additionalProperties":false}) },
        ToolDef { name: "browser_wait", description: "Wait until any condition matches: text appears, text disappears, an element ref disappears, or the URL contains a string. Use snapshot frameRef for iframe text/URL conditions; otherwise uses refGone's frame or the top document. A frameRef stays bound to its document; take a fresh snapshot after navigation. Fails with TIMEOUT.",
            schema: json!({"type":"object","properties":{"operationId":op(),"text":{"type":"string"},"textGone":{"type":"string"},
                "refGone":{"type":"string"},"urlIncludes":{"type":"string"},"frameRef":{"type":"string","description":"Document-bound frameRef returned on a browser_snapshot frame."},
                "timeoutMs":{"type":"integer","minimum":100,"maximum":30000,"default":5000}},
                "required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_extract", description: "Extract text, selection, or a table by snapshot ref (first table by default). maxChars bounds output. offset is a character index for text/selection, a data-row index for tables; follow nextOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),"kind":{"type":"string","enum":["text","selection","table"]},
                "ref":r#ref(),"maxChars":{"type":"integer","minimum":200,"maximum":50000,"default":8000},"offset":{"type":"integer","minimum":0,"default":0}},
                "required":["operationId","kind"],"additionalProperties":false}) },
        ToolDef { name: "browser_screenshot", description: "Capture the visible part of the operation tab as PNG. Only works while that tab is the active tab of its window; otherwise returns NEEDS_TAB_ACTIVATION.",
            schema: json!({"type":"object","properties":{"operationId":op()},"required":["operationId"],"additionalProperties":false}) },
    ]
}

pub fn class_of(name: &str, args: &Value) -> CommandClass {
    match name {
        "browser_navigate" | "browser_click" | "browser_fill" | "browser_select" | "browser_press" | "browser_scroll" => CommandClass::Write,
        "browser_tabs" if args["action"] == "new" || args["action"] == "close" => CommandClass::Write,
        _ => CommandClass::Read,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tools_list_matches_contract_fixture() {
        let ours: Vec<serde_json::Value> = super::all().into_iter()
            .map(|t| serde_json::json!({"name": t.name, "description": t.description, "inputSchema": t.schema}))
            .collect();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/fixtures/tools-list.json");
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(&ours).unwrap() + "\n").unwrap();
            return;
        }
        // The test executable can run on Windows after a WSL cross build.
        let fixture: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../protocol/fixtures/tools-list.json")).unwrap();
        assert_eq!(ours, fixture, "tool contract changed; review and rerun with UPDATE_FIXTURES=1");
    }

    #[test]
    fn total_schema_size_stays_small_for_free_models() {
        let size: usize = super::all().iter().map(|t| t.description.len() + t.schema.to_string().len()).sum();
        assert!(size < 6000, "tool definitions grew to {size} chars");
    }
}
