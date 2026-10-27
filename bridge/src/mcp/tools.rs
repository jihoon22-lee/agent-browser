use crate::server::registry::CommandClass;
use serde_json::{json, Value};

pub struct ToolDef { pub name: &'static str, pub description: &'static str, pub schema: Value }

/// Field descriptions repeated in every schema cost the most; the tool descriptions say where ids come from.
fn op() -> Value { json!({"type":"string"}) }
fn r#ref() -> Value { json!({"type":"string"}) }
fn wait_for() -> Value { json!({"type":"object","properties":{
    "text":{"type":"string","minLength":1,"maxLength":2000},"textGone":{"type":"string","minLength":1,"maxLength":2000},
    "urlIncludes":{"type":"string","minLength":1,"maxLength":2000},"match":{"type":"string","enum":["all","any"]},
    "timeoutMs":{"type":"integer","minimum":100,"maximum":30000}},"additionalProperties":false}) }

pub fn all() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "browser_tabs", description:
            "list/windows read tabs. In a panel request attach/new and page tools may omit requestId and operationId; otherwise attach (no tabId = request's tab) or new (url) with the Browser context requestId, then reuse operationId. Results include a snapshot and openTabs. about:blank tabs cannot be closed.",
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
            "Read page text and refs (DOM-based). Navigation, press and page-changing clicks already include one. query keeps matching lines, rows and elements. Continue with offset/elementOffset/frameOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "query":{"type":"string","maxLength":80},
                "maxChars":{"type":"integer","minimum":200,"maximum":20000},
                "offset":{"type":"integer","minimum":0},
                "elementOffset":{"type":"integer","minimum":0},
                "frameOffset":{"type":"integer","minimum":0}},
                "additionalProperties":false}) },
        ToolDef { name: "browser_navigate", description: "goto a URL, or back/forward/reload. Waits for load and returns a snapshot.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "action":{"type":"string","enum":["goto","back","forward","reload"]},
                "url":{"type":"string"}},"additionalProperties":false}) },
        ToolDef { name: "browser_click", description: "Click a ref; double/right/hover/drag (toRef). For a known outcome, use waitFor text/textGone/urlIncludes in this tab (default all, 5s): waits then returns a snapshot, without replaying the click. newTab opens a link; cannot use waitFor.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"newTab":{"type":"boolean"},
                "mode":{"type":"string","enum":["click","double","right","hover","drag"]},"toRef":{"type":"string"},"waitFor":wait_for()},"required":["ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_fill", description: "Replace the text of an input, textarea or editable area.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"text":{"type":"string"}},"required":["ref","text"],"additionalProperties":false}) },
        ToolDef { name: "browser_select", description: "Choose a select option by value or label, or set checked on a checkbox/radio.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"option":{"type":"string"},"checked":{"type":"boolean"}},"required":["ref"],"additionalProperties":false}) },
        ToolDef { name: "browser_press", description: "Press Enter/Tab/Escape/Space/Backspace/Delete/Home/End/PageUp/PageDown/arrows, or a modified letter/digit, on ref or focus; returns a snapshot. Optional waitFor works like click (default all, 5s).",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "key":{"type":"string","maxLength":10},
                "modifiers":{"type":"array","items":{"enum":["Control","Shift","Alt","Meta"]},"maxItems":4},"waitFor":wait_for()},
                "required":["key"],"additionalProperties":false}) },
        ToolDef { name: "browser_scroll", description: "Scroll the page or a ref container.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),
                "direction":{"type":"string","enum":["up","down","top","bottom"]}},"required":["direction"],"additionalProperties":false}) },
        ToolDef { name: "browser_wait", description: "Wait for text/textGone/refGone/urlIncludes. Default any; match=all combines text and URL conditions (without refGone).",
            schema: json!({"type":"object","properties":{"operationId":op(),"text":{"type":"string"},"textGone":{"type":"string"},
                "refGone":{"type":"string"},"urlIncludes":{"type":"string"},"frameRef":{"type":"string"},
                "match":{"type":"string","enum":["any","all"]},
                "timeoutMs":{"type":"integer","minimum":100,"maximum":30000}},
                "additionalProperties":false}) },
        ToolDef { name: "browser_extract", description: "Extract text, selection or a table (ref, else the first table); continue with nextOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),"kind":{"type":"string","enum":["text","selection","table"]},
                "ref":r#ref(),"maxChars":{"type":"integer","minimum":200,"maximum":50000},"offset":{"type":"integer","minimum":0}},
                "required":["kind"],"additionalProperties":false}) },
        ToolDef { name: "browser_screenshot", description: "PNG. Advanced mode (Chrome 125+, debugger) supports fullPage/region and returns a 30s captureId for visual actions. Region is viewport CSS pixels; fullPage cannot authorize input.",
            schema: json!({"type":"object","properties":{"operationId":op(),"scope":{"enum":["viewport","fullPage","region"]},"region":{"type":"object","properties":{"x":{"type":"number","minimum":0},"y":{"type":"number","minimum":0},"width":{"type":"number","exclusiveMinimum":0},"height":{"type":"number","exclusiveMinimum":0}},"required":["x","y","width","height"],"additionalProperties":false}},"additionalProperties":false}) },
        ToolDef { name: "browser_pointer", description: "Advanced visual input. Requires Chrome 125+, debugger, image-capable panel model and fresh viewport/region captureId. Use returned image pixel coordinates. Each input consumes the capture; observe again. Never guess coordinates.",
            schema: json!({"type":"object","properties":{"operationId":op(),"captureId":{"type":"string"},"mode":{"enum":["click","double","right","hover","drag","wheel"]},"x":{"type":"number","minimum":0},"y":{"type":"number","minimum":0},"toX":{"type":"number","minimum":0},"toY":{"type":"number","minimum":0},"deltaX":{"type":"number","minimum":-2000,"maximum":2000},"deltaY":{"type":"number","minimum":-2000,"maximum":2000}},"required":["captureId","x","y"],"additionalProperties":false}) },
        ToolDef { name: "browser_dialog", description: "Advanced page dialog list/respond. Respond using the returned dialogId, accept and optional prompt text. Never repeat the click that opened it. Leave-page confirmation belongs to the user.",
            schema: json!({"type":"object","properties":{"operationId":op(),"action":{"enum":["list","respond"]},"dialogId":{"type":"string"},"accept":{"type":"boolean"},"text":{"type":"string","maxLength":4000}},"required":["action"],"additionalProperties":false}) },
        ToolDef { name: "browser_downloads", description: "Advanced download candidates/status/wait; requires optional downloads permission. User binds the matching candidate in the browser panel. Never claim an unbound candidate completed this task. Does not read files or start downloads.",
            schema: json!({"type":"object","properties":{"operationId":op(),"action":{"enum":["list","status","wait"]},"downloadId":{"type":"integer","minimum":0},"timeoutMs":{"type":"integer","minimum":100,"maximum":30000}},"required":["action"],"additionalProperties":false}) },
        ToolDef { name: "browser_upload", description: "Put a file the user attached to this request into a file input (its ref, label or button). file: the attachment name.",
            schema: json!({"type":"object","properties":{"operationId":op(),"ref":r#ref(),"file":{"type":"string"}},"required":["ref","file"],"additionalProperties":false}) },
    ]
}

pub fn class_of(name: &str, args: &Value) -> CommandClass {
    match name {
        "browser_dialog" if args["action"] == "respond" => CommandClass::Write,
        "browser_pointer" | "browser_navigate" | "browser_click" | "browser_fill" | "browser_select" | "browser_press" | "browser_scroll" | "browser_upload" => CommandClass::Write,
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
        assert!(size < 8500, "tool definitions grew to {size} chars");
    }

    #[test]
    fn pointer_modes_modifiers_and_upload_are_offered() {
        let tools = super::all();
        let find = |name: &str| tools.iter().find(|t| t.name == name).unwrap();
        assert_eq!(find("browser_click").schema["properties"]["mode"]["enum"], serde_json::json!(["click","double","right","hover","drag"]));
        assert!(find("browser_click").schema["properties"]["toRef"].is_object());
        assert!(find("browser_press").schema["properties"]["modifiers"].is_object());
        assert_eq!(find("browser_upload").schema["required"], serde_json::json!(["ref","file"]));
        assert_eq!(super::class_of("browser_upload", &serde_json::json!({})), crate::server::registry::CommandClass::Write);
    }

    #[test]
    fn snapshot_can_be_narrowed_by_a_query() {
        let snapshot = super::all().into_iter().find(|t| t.name == "browser_snapshot").unwrap();
        assert_eq!(snapshot.schema["properties"]["query"]["type"], "string");
        assert!(snapshot.description.contains("query"));
    }

    #[test]
    fn page_tools_do_not_require_an_operation_id_in_the_schema() {
        for tool in super::all() {
            let required = tool.schema["required"].as_array().cloned().unwrap_or_default();
            assert!(!required.iter().any(|k| k == "operationId"), "{} still requires operationId", tool.name);
        }
        let tabs = super::all().into_iter().find(|t| t.name == "browser_tabs").unwrap();
        assert!(tabs.description.contains("panel"), "the description must say ids may be omitted in a panel request");
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

#[cfg(test)]
mod advanced_tests {
    use super::*;
    #[test]
    fn visual_dialog_and_download_tools_are_explicit_and_classified() {
        let list=all();
        for name in ["browser_pointer","browser_dialog","browser_downloads"] {assert!(list.iter().any(|t|t.name==name),"missing {name}");}
        assert_eq!(class_of("browser_pointer",&json!({})),CommandClass::Write);
        assert_eq!(class_of("browser_dialog",&json!({"action":"respond"})),CommandClass::Write);
        assert_eq!(class_of("browser_dialog",&json!({"action":"list"})),CommandClass::Read);
    }
}
