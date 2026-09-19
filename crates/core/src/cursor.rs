//! Buffered row windows. Phase 1 drivers materialise up to `limit` rows; the
//! engine parks them here and the UI pulls windows with `cursor_fetch`, so IPC
//! only ever carries a screenful (PLAN.md §8a).

use crate::ipc::*;
use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Default maximum age of an idle cursor.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(30 * 60);
/// Default cap on rows buffered across all cursors.
pub const DEFAULT_MAX_TOTAL_ROWS: usize = 1_000_000;

#[derive(Debug, Clone)]
pub struct CursorState {
    pub workspace_id: WorkspaceId,
    pub columns: Vec<ColumnDesc>,
    pub rows: Vec<Vec<Cell>>,
    pub truncated: bool,
    pub created_at: Instant,
}

pub struct Cursors {
    map: DashMap<CursorId, CursorState>,
    max_age: Duration,
    max_total_rows: usize,
}

impl Default for Cursors {
    fn default() -> Self {
        Self::new()
    }
}

impl Cursors {
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_MAX_AGE, DEFAULT_MAX_TOTAL_ROWS)
    }

    pub fn with_limits(max_age: Duration, max_total_rows: usize) -> Self {
        Self {
            map: DashMap::new(),
            max_age,
            max_total_rows,
        }
    }

    /// Park a materialised result and hand back its cursor id. Runs eviction
    /// first so a big new result pushes the oldest ones out.
    pub fn insert(
        &self,
        workspace_id: &str,
        columns: Vec<ColumnDesc>,
        rows: Vec<Vec<Cell>>,
        truncated: bool,
    ) -> CursorId {
        self.evict_with_incoming(rows.len());
        let id = uuid::Uuid::new_v4().to_string();
        self.map.insert(
            id.clone(),
            CursorState {
                workspace_id: workspace_id.to_string(),
                columns,
                rows,
                truncated,
                created_at: Instant::now(),
            },
        );
        id
    }

    /// Serve a window. `offset`/`len` are clamped to the buffer.
    pub fn fetch(&self, cursor_id: &str, offset: u64, len: u32) -> Result<RowWindow, IpcError> {
        let state = self.map.get(cursor_id).ok_or_else(|| {
            IpcError::not_found(format!("Cursor {cursor_id} is closed or expired"))
        })?;
        let total = state.rows.len();
        let start = (offset as usize).min(total);
        let end = start.saturating_add(len as usize).min(total);
        let rows = state.rows[start..end].to_vec();
        Ok(RowWindow {
            cursor_id: cursor_id.to_string(),
            offset: start as u64,
            rows,
            buffered: total as u64,
            truncated: state.truncated,
            exhausted: start.saturating_add(len as usize) >= total,
        })
    }

    pub fn columns(&self, cursor_id: &str) -> Option<Vec<ColumnDesc>> {
        self.map.get(cursor_id).map(|s| s.columns.clone())
    }

    /// Drop a cursor. Returns whether it existed.
    pub fn close(&self, cursor_id: &str) -> bool {
        self.map.remove(cursor_id).is_some()
    }

    /// Drop every cursor belonging to a workspace.
    pub fn close_workspace(&self, workspace_id: &str) {
        self.map.retain(|_, s| s.workspace_id != workspace_id);
    }

    /// Evict cursors older than `max_age`, then drop oldest cursors until the
    /// total buffered rows fits under `max_total_rows`.
    pub fn evict(&self) {
        self.evict_with_incoming(0);
    }

    fn evict_with_incoming(&self, incoming_rows: usize) {
        let now = Instant::now();
        self.map
            .retain(|_, s| now.duration_since(s.created_at) < self.max_age);

        let budget = self.max_total_rows.saturating_sub(incoming_rows);
        let mut total: usize = self.map.iter().map(|e| e.rows.len()).sum();
        if total <= budget {
            return;
        }
        let mut by_age: Vec<(Instant, CursorId, usize)> = self
            .map
            .iter()
            .map(|e| (e.created_at, e.key().clone(), e.rows.len()))
            .collect();
        by_age.sort_by_key(|(at, _, _)| *at);
        for (_, id, n) in by_age {
            if total <= budget {
                break;
            }
            self.map.remove(&id);
            total = total.saturating_sub(n);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn total_rows(&self) -> usize {
        self.map.iter().map(|e| e.rows.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(n: usize) -> Vec<Vec<Cell>> {
        (0..n).map(|i| vec![json!(i.to_string())]).collect()
    }

    #[test]
    fn windows_are_clamped() {
        let c = Cursors::new();
        let id = c.insert("ws", vec![], rows(10), false);

        let w = c.fetch(&id, 0, 4).expect("fetch");
        assert_eq!(w.rows.len(), 4);
        assert_eq!(w.offset, 0);
        assert_eq!(w.buffered, 10);
        assert!(!w.exhausted);
        assert!(!w.truncated);

        let w = c.fetch(&id, 8, 4).expect("fetch");
        assert_eq!(w.rows.len(), 2);
        assert_eq!(w.rows[0][0], json!("8"));
        assert!(w.exhausted);

        let w = c.fetch(&id, 6, 4).expect("fetch");
        assert_eq!(w.rows.len(), 4);
        assert!(w.exhausted, "offset+len == len counts as exhausted");

        let w = c.fetch(&id, 50, 4).expect("fetch");
        assert!(w.rows.is_empty());
        assert_eq!(w.offset, 10);
        assert!(w.exhausted);
    }

    #[test]
    fn truncated_flag_and_close() {
        let c = Cursors::new();
        let id = c.insert("ws", vec![], rows(3), true);
        assert!(c.fetch(&id, 0, 10).expect("fetch").truncated);
        assert!(c.close(&id));
        assert!(!c.close(&id));
        assert_eq!(
            c.fetch(&id, 0, 1).err().map(|e| e.code),
            Some("not-found".to_string())
        );
    }

    #[test]
    fn close_workspace_drops_only_its_cursors() {
        let c = Cursors::new();
        let a = c.insert("ws-a", vec![], rows(1), false);
        let b = c.insert("ws-b", vec![], rows(1), false);
        c.close_workspace("ws-a");
        assert!(c.fetch(&a, 0, 1).is_err());
        assert!(c.fetch(&b, 0, 1).is_ok());
    }

    #[test]
    fn evicts_oldest_over_row_budget() {
        let c = Cursors::with_limits(DEFAULT_MAX_AGE, 100);
        let first = c.insert("ws", vec![], rows(60), false);
        std::thread::sleep(Duration::from_millis(2));
        let second = c.insert("ws", vec![], rows(30), false);
        assert_eq!(c.len(), 2);
        std::thread::sleep(Duration::from_millis(2));
        let third = c.insert("ws", vec![], rows(30), false);
        // 60 + 30 + 30 > 100 → the oldest (60) goes.
        assert!(c.fetch(&first, 0, 1).is_err());
        assert!(c.fetch(&second, 0, 1).is_ok());
        assert!(c.fetch(&third, 0, 1).is_ok());
        assert_eq!(c.total_rows(), 60);
    }

    #[test]
    fn evicts_expired() {
        let c = Cursors::with_limits(Duration::from_millis(1), 1000);
        let id = c.insert("ws", vec![], rows(5), false);
        std::thread::sleep(Duration::from_millis(5));
        c.evict();
        assert!(c.is_empty());
        assert!(c.fetch(&id, 0, 1).is_err());
    }
}
