//! Indexing JSON that does not fit in a browser.
//!
//! A gigabyte of JSON cannot go through the webview. As a JavaScript string it
//! is two gigabytes of UTF-16 before anything is parsed, and `JSON.parse`
//! allocates a second copy as objects — so the tab is dead long before a tree
//! is drawn. Every viewer that handles files this size does the same thing
//! instead, and so does this one:
//!
//!   1. keep the **bytes** in one place and never copy them;
//!   2. scan them once into a **flat index** of fixed-size records — no
//!      `serde_json::Value`, no allocation per node;
//!   3. let the window ask for the handful of rows it is about to draw.
//!
//! The index is the only thing that grows with the document: 32 bytes a node,
//! so a million nodes is 32 MB. The bytes stay put and slices are decoded on
//! demand, which is why memory tracks file size rather than three to ten
//! times it.
//!
//! The scanner is **tolerant on purpose**. A file this size is usually being
//! opened *because* something is wrong with it, and a parser that answers
//! "unexpected token at byte 918,443,001" and nothing else has told you
//! almost nothing. It records what is wrong, where, and carries on.

use serde::{Deserialize, Serialize};

/// What a node is. Kept as a `u8` in the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JsonKind {
    Object,
    Array,
    String,
    Number,
    Bool,
    Null,
}

/// One node of the flattened document.
///
/// Offsets are `u32`, which caps a document at 4 GiB. That is a deliberate
/// trade: widening them to `u64` costs eight bytes on every node — 8 MB per
/// million — to support files nobody opens in a GUI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct IndexNode {
    /// Byte range of the key, without quotes. `len` is 0 when there is none.
    pub key_off: u32,
    pub key_len: u32,
    /// Byte range of the value. For a container it spans the brackets.
    pub val_off: u32,
    pub val_len: u32,
    pub parent: u32,
    /// One past the last descendant, so a subtree is skipped with one jump.
    pub end: u32,
    /// Children, for containers.
    pub count: u32,
    /// Saturates at `u16::MAX`. Past 65,535 levels the indentation simply
    /// stops growing, which is a cosmetic limit; wrapping would not be.
    pub depth: u16,
    pub kind: JsonKind,
    /// The key is an array index rather than a name.
    pub indexed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexIssue {
    /// `error` when something was skipped, `lenient` when it was understood.
    pub kind: String,
    pub message: String,
    pub offset: u32,
    /// The node it belongs to.
    pub node: u32,
}

#[derive(Debug, Default)]
pub struct JsonIndex {
    pub nodes: Vec<IndexNode>,
    pub issues: Vec<IndexIssue>,
    pub truncated: bool,
}

/// Anything past this and the caller is told, rather than waiting.
pub const MAX_BYTES: usize = 4 * 1024 * 1024 * 1024 - 1;

struct Scanner<'a> {
    b: &'a [u8],
    i: usize,
    out: JsonIndex,
}

#[inline]
fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline]
fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'+' | b'.' | b'$')
}

impl<'a> Scanner<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0, out: JsonIndex::default() }
    }

    fn note(&mut self, kind: &str, message: impl Into<String>, at: usize) {
        // One complaint per position: a run of bad bytes is one problem.
        if self.out.issues.last().map(|p| p.offset as usize) == Some(at) {
            return;
        }
        let node = self.out.nodes.len().saturating_sub(1) as u32;
        self.out.issues.push(IndexIssue { kind: kind.into(), message: message.into(), offset: at as u32, node });
    }

    fn skip_ws(&mut self) {
        loop {
            while self.i < self.b.len() && is_ws(self.b[self.i]) {
                self.i += 1;
            }
            // Comments are not JSON and are in half the files that have them.
            if self.i + 1 < self.b.len() && self.b[self.i] == b'/' && self.b[self.i + 1] == b'/' {
                let at = self.i;
                self.note("lenient", "Line comment — not valid JSON", at);
                while self.i < self.b.len() && self.b[self.i] != b'\n' {
                    self.i += 1;
                }
                continue;
            }
            if self.i + 1 < self.b.len() && self.b[self.i] == b'/' && self.b[self.i + 1] == b'*' {
                let at = self.i;
                self.note("lenient", "Block comment — not valid JSON", at);
                self.i += 2;
                while self.i + 1 < self.b.len() && !(self.b[self.i] == b'*' && self.b[self.i + 1] == b'/') {
                    self.i += 1;
                }
                self.i = (self.i + 2).min(self.b.len());
                continue;
            }
            return;
        }
    }

    /// Consume a string and return its inner byte range. Escapes are left as
    /// they are: decoding happens when a row is actually displayed.
    fn read_string(&mut self) -> (u32, u32) {
        let quote = self.b[self.i];
        if quote == b'\'' {
            let at = self.i;
            self.note("lenient", "Single-quoted string — JSON uses double quotes", at);
        }
        self.i += 1;
        let start = self.i;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'\\' => self.i += 2,
                c if c == quote => {
                    let end = self.i;
                    self.i += 1;
                    return (start as u32, (end - start) as u32);
                }
                _ => self.i += 1,
            }
        }
        self.out.truncated = true;
        let at = self.b.len();
        self.note("error", "String is not closed before the end of the document", at);
        (start as u32, (self.b.len() - start) as u32)
    }

    fn read_word(&mut self) -> (usize, usize) {
        let start = self.i;
        while self.i < self.b.len() && is_word(self.b[self.i]) {
            self.i += 1;
        }
        (start, self.i)
    }

    /// Skip to the next `,` or to the closing bracket at this depth.
    fn recover(&mut self) {
        let mut depth = 0i32;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'"' | b'\'' => {
                    self.read_string();
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    if depth == 0 {
                        return;
                    }
                    depth -= 1;
                }
                b',' if depth == 0 => return,
                _ => {}
            }
            self.i += 1;
        }
    }

    fn push(&mut self, key: (u32, u32), indexed: bool, kind: JsonKind, val: (u32, u32), depth: u16, parent: u32) -> usize {
        let i = self.out.nodes.len();
        self.out.nodes.push(IndexNode {
            key_off: key.0,
            key_len: key.1,
            val_off: val.0,
            val_len: val.1,
            parent,
            end: i as u32 + 1,
            count: 0,
            depth,
            kind,
            indexed,
        });
        i
    }
}

struct Frame {
    node: usize,
    kind: JsonKind,
    count: u32,
}

/// Scan the bytes into a flat index. Never recurses, never allocates per node.
pub fn index_json(bytes: &[u8]) -> JsonIndex {
    let mut s = Scanner::new(bytes);
    let mut stack: Vec<Frame> = Vec::new();
    let mut root_done = false;

    loop {
        // ── inside a container: read the next member, or close it
        if let Some(top) = stack.last() {
            let closing = if top.kind == JsonKind::Object { b'}' } else { b']' };
            let depth = s.out.nodes[top.node].depth.saturating_add(1);
            let parent = top.node as u32;
            s.skip_ws();

            if s.i >= s.b.len() {
                s.out.truncated = true;
                let at = s.b.len();
                let what = if closing == b'}' { "Object" } else { "Array" };
                s.note("error", format!("{what} is not closed before the end of the document"), at);
                close_frame(&mut s, &mut stack, &mut root_done);
                continue;
            }
            if s.b[s.i] == closing {
                s.i += 1;
                close_frame(&mut s, &mut stack, &mut root_done);
                after_member(&mut s, &mut stack, &mut root_done);
                continue;
            }
            if s.b[s.i] == b',' {
                let at = s.i;
                s.note("error", if closing == b'}' { "Empty member" } else { "Empty element" }, at);
                s.i += 1;
                continue;
            }

            let pending_key: (u32, u32);
            let pending_indexed: bool;
            if top.kind == JsonKind::Object {
                // the key
                if s.b[s.i] == b'"' || s.b[s.i] == b'\'' {
                    pending_key = s.read_string();
                } else {
                    let at = s.i;
                    let (a, z) = s.read_word();
                    if a == z {
                        s.note("error", "Expected a key", at);
                        s.recover();
                        if s.i < s.b.len() && s.b[s.i] == b',' {
                            s.i += 1;
                        }
                        continue;
                    }
                    s.note("lenient", "Unquoted key — JSON requires quotes", at);
                    pending_key = (a as u32, (z - a) as u32);
                }
                pending_indexed = false;
                s.skip_ws();
                if s.i < s.b.len() && s.b[s.i] == b':' {
                    s.i += 1;
                } else {
                    let at = s.i;
                    s.note("error", "Missing ':' after the key", at);
                }
            } else {
                let n = stack.last().map(|f| f.count).unwrap_or(0);
                pending_key = (n, 0); // arrays carry their index in key_off
                pending_indexed = true;
            }

            read_value(&mut s, &mut stack, pending_key, pending_indexed, depth, parent, &mut root_done);
            continue;
        }

        // ── the root
        if root_done {
            break;
        }
        s.skip_ws();
        if s.i >= s.b.len() {
            s.out.truncated = true;
            let at = s.b.len();
            s.note("error", "Document is empty", at);
            break;
        }
        read_value(&mut s, &mut stack, (0, 0), false, 0, u32::MAX, &mut root_done);
    }

    s.skip_ws();
    if s.i < s.b.len() {
        let at = s.i;
        let left = s.b.len() - s.i;
        s.note("error", format!("Extra content after the document ({left} more bytes)"), at);
    }
    s.out
}

/// Read one value at the cursor, pushing a frame for a container.
fn read_value(
    s: &mut Scanner<'_>,
    stack: &mut Vec<Frame>,
    key: (u32, u32),
    indexed: bool,
    depth: u16,
    parent: u32,
    root_done: &mut bool,
) {
    s.skip_ws();
    if s.i >= s.b.len() {
        s.out.truncated = true;
        let at = s.b.len();
        s.note("error", "Document ends where a value was expected", at);
        return;
    }
    let start = s.i;
    let c = s.b[s.i];

    if c == b'{' || c == b'[' {
        let kind = if c == b'{' { JsonKind::Object } else { JsonKind::Array };
        let node = s.push(key, indexed, kind, (start as u32, 0), depth, parent);
        if let Some(p) = stack.last_mut() {
            p.count += 1;
        }
        s.i += 1;
        stack.push(Frame { node, kind, count: 0 });
        return;
    }

    let (kind, val) = match c {
        b'"' | b'\'' => (JsonKind::String, s.read_string()),
        b'}' | b']' | b',' | b':' => {
            s.note("error", format!("Expected a value, found {:?}", c as char), start);
            (JsonKind::Null, (start as u32, 0))
        }
        _ => {
            let (a, z) = s.read_word();
            if a == z {
                s.note("error", "Unexpected character", start);
                s.recover();
                (JsonKind::Null, (start as u32, 0))
            } else {
                let word = &s.b[a..z];
                let kind = match word {
                    b"true" | b"false" => JsonKind::Bool,
                    b"null" => JsonKind::Null,
                    b"NaN" | b"Infinity" | b"-Infinity" | b"+Infinity" => {
                        s.note("lenient", format!("{} is not valid JSON", String::from_utf8_lossy(word)), a);
                        JsonKind::Number
                    }
                    _ => {
                        if word.iter().all(|&x| x.is_ascii_digit() || matches!(x, b'-' | b'+' | b'.' | b'e' | b'E')) {
                            JsonKind::Number
                        } else {
                            s.note("error", format!("Unexpected {:?}", String::from_utf8_lossy(word)), a);
                            JsonKind::Null
                        }
                    }
                };
                (kind, (a as u32, (z - a) as u32))
            }
        }
    };

    s.push(key, indexed, kind, val, depth, parent);
    if let Some(p) = stack.last_mut() {
        p.count += 1;
    } else {
        *root_done = true;
        return;
    }
    after_member(s, stack, root_done);
}

/// A comma carries on, a bracket closes, anything else is recovered from.
fn after_member(s: &mut Scanner<'_>, stack: &mut Vec<Frame>, root_done: &mut bool) {
    loop {
        let Some(top) = stack.last() else { return };
        let closing = if top.kind == JsonKind::Object { b'}' } else { b']' };
        s.skip_ws();
        if s.i >= s.b.len() {
            s.out.truncated = true;
            let at = s.b.len();
            let what = if closing == b'}' { "Object" } else { "Array" };
            s.note("error", format!("{what} is not closed before the end of the document"), at);
            close_frame(s, stack, root_done);
            continue;
        }
        if s.b[s.i] == b',' {
            s.i += 1;
            s.skip_ws();
            if s.i < s.b.len() && s.b[s.i] == closing {
                let at = s.i - 1;
                s.note("lenient", "Trailing comma", at);
            }
            return;
        }
        if s.b[s.i] == closing {
            s.i += 1;
            close_frame(s, stack, root_done);
            continue;
        }
        let at = s.i;
        s.note("error", format!("Expected ',' or '{}'", closing as char), at);
        s.recover();
        if s.i < s.b.len() && s.b[s.i] == b',' {
            s.i += 1;
        }
        return;
    }
}

fn close_frame(s: &mut Scanner<'_>, stack: &mut Vec<Frame>, root_done: &mut bool) {
    let Some(frame) = stack.pop() else { return };
    let end = s.out.nodes.len() as u32;
    let node = &mut s.out.nodes[frame.node];
    node.end = end;
    node.count = frame.count;
    node.val_len = (s.i as u32).saturating_sub(node.val_off);
    if stack.is_empty() {
        *root_done = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(idx: &JsonIndex) -> Vec<JsonKind> {
        idx.nodes.iter().map(|n| n.kind).collect()
    }
    fn key<'a>(b: &'a [u8], n: &IndexNode) -> &'a str {
        std::str::from_utf8(&b[n.key_off as usize..(n.key_off + n.key_len) as usize]).unwrap()
    }
    fn val<'a>(b: &'a [u8], n: &IndexNode) -> &'a str {
        std::str::from_utf8(&b[n.val_off as usize..(n.val_off + n.val_len) as usize]).unwrap()
    }

    #[test]
    fn indexes_a_document() {
        let b = br#"{"id":7,"name":"Ada","tags":["a","b"],"ok":true,"nil":null}"#;
        let idx = index_json(b);
        assert!(idx.issues.is_empty(), "{:?}", idx.issues);
        assert_eq!(idx.nodes.len(), 1 + 5 + 2);
        assert_eq!(idx.nodes[0].kind, JsonKind::Object);
        assert_eq!(idx.nodes[0].count, 5);
        // The subtree of `tags` is contiguous, which is what makes collapsing
        // one jump rather than a walk.
        let tags = idx.nodes.iter().position(|n| key(b, n) == "tags").unwrap();
        let sub: Vec<&str> = idx.nodes[tags + 1..idx.nodes[tags].end as usize].iter().map(|n| val(b, n)).collect();
        assert_eq!(sub, vec!["a", "b"]);
        assert_eq!(val(b, &idx.nodes[1]), "7");
        assert_eq!(kinds(&idx)[1..], [JsonKind::Number, JsonKind::String, JsonKind::Array, JsonKind::String, JsonKind::String, JsonKind::Bool, JsonKind::Null]);
    }

    #[test]
    fn array_children_carry_their_index() {
        let idx = index_json(br#"[10,20,30]"#);
        assert_eq!(idx.nodes.len(), 4);
        let children: Vec<u32> = idx.nodes[1..].iter().map(|n| n.key_off).collect();
        assert_eq!(children, vec![0, 1, 2]);
        assert!(idx.nodes[1..].iter().all(|n| n.indexed));
    }

    #[test]
    fn nesting_is_not_recursion() {
        // The depth that ends a recursive parser. 200k here.
        let mut b = Vec::new();
        b.extend(std::iter::repeat_n(b'[', 200_000));
        b.push(b'1');
        b.extend(std::iter::repeat_n(b']', 200_000));
        let idx = index_json(&b);
        assert_eq!(idx.nodes.len(), 200_001);
        assert!(idx.issues.is_empty());
        // Depth saturates rather than wrapping: 200,000 levels reports 65,535.
        assert_eq!(idx.nodes.last().unwrap().depth, u16::MAX);
    }

    #[test]
    fn broken_documents_still_index() {
        let b = br#"{"a":1,"b":@@@,"c":3}"#;
        let idx = index_json(b);
        let errors: Vec<&IndexIssue> = idx.issues.iter().filter(|i| i.kind == "error").collect();
        assert_eq!(errors.len(), 1, "{:?}", idx.issues);
        // Everything either side of the mistake survives.
        let keys: Vec<&str> = idx.nodes[1..].iter().map(|n| key(b, n)).collect();
        assert_eq!(keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn truncation_is_reported_and_survivable() {
        let b = br#"{"rows":[{"id":1},{"id":2},{"id":"#;
        let idx = index_json(b);
        assert!(idx.truncated);
        let rows = idx.nodes.iter().find(|n| key(b, n) == "rows").unwrap();
        assert_eq!(rows.count, 3);
    }

    #[test]
    fn the_everyday_not_quite_json() {
        let b = br#"{ /* c */ name: 'ada', port: 8080, tags: ["x",], }"#;
        let idx = index_json(b);
        assert!(idx.issues.iter().all(|i| i.kind == "lenient"), "{:?}", idx.issues);
        let keys: Vec<&str> = idx.nodes[1..].iter().filter(|n| n.key_len > 0 && !n.indexed).map(|n| key(b, n)).collect();
        assert_eq!(keys, vec!["name", "port", "tags"]);
    }

    /// The gigabyte claim, measured rather than asserted. Ignored by default
    /// because it allocates the document twice over; run it with
    /// `cargo test --release -p plinth-core -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_gigabyte() {
        let record = br#"{"id":000000,"email":"user000000@example.com","country":"DE","tier":"enterprise","score":42,"tags":["alpha","beta"],"active":true,"note":"a reasonably sized field so the record looks like something real"}"#;
        let target = 1024usize * 1024 * 1024;
        let mut b = Vec::with_capacity(target + 64);
        b.extend_from_slice(b"[");
        while b.len() < target {
            if b.len() > 1 {
                b.push(b',');
            }
            b.extend_from_slice(record);
        }
        b.extend_from_slice(b"]");

        let t = std::time::Instant::now();
        let idx = index_json(&b);
        let ms = t.elapsed().as_millis();
        let index_bytes = idx.nodes.len() * std::mem::size_of::<IndexNode>();
        println!(
            "{:.2} GB · {} nodes · indexed in {ms} ms · index {:.2} GB ({:.0}% of the file)",
            b.len() as f64 / 1e9,
            idx.nodes.len(),
            index_bytes as f64 / 1e9,
            index_bytes as f64 / b.len() as f64 * 100.0,
        );
        assert!(idx.issues.is_empty());
    }

    #[test]
    fn a_big_document_indexes_in_one_pass() {
        // 50,000 records, four fields each — the shape of an export.
        let mut b = Vec::from(&b"{\"rows\":["[..]);
        for n in 0..50_000 {
            if n > 0 {
                b.push(b',');
            }
            b.extend_from_slice(format!(r#"{{"id":{n},"email":"user{n}@example.com","ok":true,"score":{}}}"#, n % 100).as_bytes());
        }
        b.extend_from_slice(b"]}");
        let t = std::time::Instant::now();
        let idx = index_json(&b);
        let ms = t.elapsed().as_millis();
        assert!(idx.issues.is_empty());
        assert_eq!(idx.nodes.len(), 1 + 1 + 50_000 * 5);
        // 32 bytes a node is the whole point of the fixed-size record.
        assert_eq!(std::mem::size_of::<IndexNode>(), 32);
        println!("{} bytes → {} nodes in {ms} ms", b.len(), idx.nodes.len());
    }
}
