use std::{collections::VecDeque, sync::Mutex};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub at_ms: u64,
    pub operation_id: Option<String>,
    pub tool: String,
    pub summary: String,
    pub outcome: String, // "ok" or an ErrorCode string
}

#[derive(Default)]
pub struct Timeline { inner: Mutex<VecDeque<TimelineEntry>> }

impl Timeline {
    pub const MAX: usize = 200;
    pub fn push(&self, e: TimelineEntry) {
        let mut q = self.inner.lock().unwrap();
        if q.len() == Self::MAX { q.pop_front(); }
        q.push_back(e);
    }
    pub fn entries(&self) -> Vec<TimelineEntry> { self.inner.lock().unwrap().iter().cloned().collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_only_latest_entries() {
        let t = Timeline::default();
        for i in 0..(Timeline::MAX + 5) {
            t.push(TimelineEntry { at_ms: i as u64, operation_id: None, tool: "x".into(), summary: String::new(), outcome: "ok".into() });
        }
        let e = t.entries();
        assert_eq!(e.len(), Timeline::MAX);
        assert_eq!(e[0].at_ms, 5);
    }
}
