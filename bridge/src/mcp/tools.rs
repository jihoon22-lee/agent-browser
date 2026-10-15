use crate::server::registry::CommandClass;
use serde_json::{json, Value};

pub struct ToolDef { pub name: &'static str, pub description: &'static str, pub schema: Value }

fn op() -> Value { json!({"type":"string","description":"From attach/new"}) }
fn r#ref() -> Value { json!({"type":"string","description":"Snapshot ref"}) }

pub fn all() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "browser_tabs", description:
            "list/windows read tabs. attach (no tabId = request's tab) or new (url) starts work with the Browser context requestId; then reuse the returned operationId. Results include a snapshot and openTabs. switch/close/release take operationId; about:blank tabs cannot be closed.",
            schema: json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","windows","attach","new","switch","close","release"]},
                "tabId":{"type":"integer"},
                "requestId":{"type":"string","description":"From Browser context; first attach/new"},
                "url":{"type":"string","description":"new: http(s) URL or about:blank"},
                "windowId":{"type":"integer","minimum":1},
                "operationId": op()},
                "required":["action"],"additionalProperties":false}) },
        ToolDef { name: "browser_bookmarks", description: "Read-only bookmarks: list a folder (folderId) or search. Needs the optional bookmarks permission.",
            schema: json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","search"]},
                "folderId":{"type":"string"},"query":{"type":"string"},
                "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}},
                "additionalProperties":false}) },
        ToolDef { name: "browser_snapshot", description:
            "Re-read page text and elements with refs (DOM-based); actions already return one. Continue with offset/elementOffset/frameOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "maxChars":{"type":"integer","minimum":200,"maximum":20000},
                "offset":{"type":"integer","minimum":0},
                "elementOffset":{"type":"integer","minimum":0},
                "frameOffset":{"type":"integer","minimum":0}},
                "required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_navigate", description: "goto a URL, or back/forward/reload. Waits for load and returns a snapshot.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "action":{"type":"string","enum":["goto","back","forward","reload"]},
                "url":{"type":"string"}},"required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_click", description: "Click a ref; returns a snapshot if the page changed. newTab opens an http(s) link in a new operation tab.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"newTab":{"type":"boolean"}},"required":["operationId","ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_fill", description: "Replace the text of an input, textarea or editable area.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"text":{"type":"string"}},"required":["operationId","ref","text"],"additionalProperties":false}) },
        ToolDef { name: "browser_select", description: "Choose a select option by value or label, or set checked on a checkbox/radio.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"option":{"type":"string"},"checked":{"type":"boolean"}},"required":["operationId","ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_press", description: "Press a key on ref or the focused element (Enter in a field submits); returns a snapshot.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "key":{"type":"string","enum":["Enter","Tab","Escape","Space","Backspace","ArrowUp","ArrowDown"]}},
                "required":["operationId","key"],"additionalProperties":false}) },
        ToolDef { name: "browser_scroll", description: "Scroll the page or a ref container.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "direction":{"type":"string","enum":["up","down","top","bottom"]}},"required":["operationId","direction"],"additionalProperties":false}) },
        ToolDef { name: "browser_wait", description: "Wait until any of text, textGone, refGone or urlIncludes holds, or timeout.",
            schema: json!({"type":"object","properties":{"operationId":op(),"text":{"type":"string"},"textGone":{"type":"string"},
                "refGone":{"type":"string"},"urlIncludes":{"type":"string"},"frameRef":{"type":"string"},
                "timeoutMs":{"type":"integer","minimum":100,"maximum":30000}},
                "required":["operationId"],"additionalProperties":false}) },
        ToolDef { name: "browser_extract", description: "Extract text, selection or a table (ref, else the first table); continue with nextOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),"kind":{"type":"string","enum":["text","selection","table"]},
                "ref":r#ref(),"maxChars":{"type":"integer","minimum":200,"maximum":50000},"offset":{"type":"integer","minimum":0}},
                "required":["operationId","kind"],"additionalProperties":false}) },
        ToolDef { name: "browser_screenshot", description: "PNG of the operation tab; that tab must be active.",
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
        assert!(size < 4800, "tool definitions grew to {size} chars");
    }

    #[test]
    fn descriptions_say_results_already_include_a_snapshot() {
        let tools = super::all();
        for name in ["browser_tabs", "browser_navigate", "browser_click", "browser_press"] {
            assert!(tools.iter().find(|t| t.name == name).unwrap().description.contains("snapshot"), "{name}");
        }
    }
}

#[cfg(test)]
mod issue8_tests {
    #[test]
    fn blank_tab_close_exception_is_visible_in_the_tool_description() {
        let tools=super::all();
        let tabs=tools.iter().find(|tool|tool.name=="browser_tabs").unwrap();
        assert!(tabs.description.contains("about:blank tabs cannot be closed"));
    }
}
