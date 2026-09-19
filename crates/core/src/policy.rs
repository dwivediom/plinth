//! Statement splitting, classification and the three-tier query policy
//! (PLAN.md §4). Classification parses with `sqlparser`; whatever it cannot
//! parse is treated as unknown and — under `ReadOnly` — rejected. Fail closed.

use crate::ipc::*;
use sqlparser::ast::{self, SetExpr, Statement};
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

/// Outcome of [`classify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub kind: StatementKind,
    /// `false` when `sqlparser` could not parse the statement and the kind
    /// came from first-keyword heuristics.
    pub parsed: bool,
    /// For `UPDATE` / `DELETE`: whether a `WHERE` clause is present.
    pub has_where: Option<bool>,
    /// `EXPLAIN` / `DESCRIBE` of a statement. Note that `EXPLAIN ANALYZE` of a
    /// write is classified by the inner write because it executes it.
    pub is_explain: bool,
}

pub fn dialect_for(kind: DriverKind) -> Box<dyn Dialect> {
    match kind {
        DriverKind::Postgres => Box::new(PostgreSqlDialect {}),
        DriverKind::Mysql => Box::new(MySqlDialect {}),
        DriverKind::Sqlite => Box::new(SQLiteDialect {}),
    }
}

// ───────────────────────── splitting ─────────────────────────

/// Split a script into statements on top-level `;`, honouring string literals,
/// quoted identifiers, comments and (Postgres) dollar-quoting. The original
/// text of each statement is preserved (trimmed, without the terminator);
/// empty and comment-only statements are dropped.
pub fn split_statements(kind: DriverKind, sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    // Did the current statement contain anything other than whitespace / comments?
    let mut has_content = false;

    let backslash_escapes = matches!(kind, DriverKind::Mysql);
    let hash_comments = matches!(kind, DriverKind::Mysql);
    let dollar_quotes = matches!(kind, DriverKind::Postgres);
    let nested_block_comments = matches!(kind, DriverKind::Postgres);

    let push = |out: &mut Vec<String>, s: &str, has_content: bool| {
        let t = s.trim();
        if has_content && !t.is_empty() {
            out.push(t.to_string());
        }
    };

    while i < n {
        let c = bytes[i];
        match c {
            b';' => {
                push(&mut out, &sql[start..i], has_content);
                i += 1;
                start = i;
                has_content = false;
            }
            b'-' if i + 1 < n && bytes[i + 1] == b'-' => {
                i = skip_line_comment(bytes, i);
            }
            b'#' if hash_comments => {
                i = skip_line_comment(bytes, i);
            }
            b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                i = skip_block_comment(bytes, i, nested_block_comments);
            }
            b'\'' => {
                has_content = true;
                // Postgres: E'...' strings use backslash escapes even with
                // standard_conforming_strings on.
                let escaped = backslash_escapes
                    || (kind == DriverKind::Postgres
                        && i > 0
                        && (bytes[i - 1] == b'E' || bytes[i - 1] == b'e')
                        && (i < 2 || !is_ident_byte(bytes[i - 2])));
                i = skip_quoted(bytes, i, b'\'', escaped);
            }
            b'"' => {
                has_content = true;
                i = skip_quoted(bytes, i, b'"', backslash_escapes);
            }
            b'`' => {
                has_content = true;
                i = skip_quoted(bytes, i, b'`', false);
            }
            b'[' if kind == DriverKind::Sqlite => {
                has_content = true;
                i = skip_until(bytes, i + 1, b']');
            }
            b'$' if dollar_quotes => {
                has_content = true;
                if let Some(tag_end) = dollar_tag_end(bytes, i) {
                    let tag = &bytes[i..=tag_end];
                    i = skip_dollar_quoted(bytes, tag_end + 1, tag);
                } else {
                    i += 1;
                }
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    has_content = true;
                }
                i += 1;
            }
        }
    }
    push(&mut out, &sql[start..n], has_content);
    out
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn skip_line_comment(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

fn skip_block_comment(bytes: &[u8], mut i: usize, nested: bool) -> usize {
    let n = bytes.len();
    let mut depth = 1usize;
    i += 2;
    while i < n {
        if bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else if nested && bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            depth += 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    n
}

/// `i` points at the opening quote. Returns the index after the closing quote
/// (or the end of input when unterminated). Doubled quotes are an escape.
fn skip_quoted(bytes: &[u8], mut i: usize, quote: u8, backslash: bool) -> usize {
    let n = bytes.len();
    i += 1;
    while i < n {
        let c = bytes[i];
        if backslash && c == b'\\' {
            i += 2;
            continue;
        }
        if c == quote {
            if i + 1 < n && bytes[i + 1] == quote {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    n
}

fn skip_until(bytes: &[u8], mut i: usize, end: u8) -> usize {
    while i < bytes.len() {
        if bytes[i] == end {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

/// `i` points at a `$`. If it opens a dollar-quote tag (`$$` or `$tag$`),
/// return the index of the closing `$` of the tag.
fn dollar_tag_end(bytes: &[u8], i: usize) -> Option<usize> {
    let n = bytes.len();
    let mut j = i + 1;
    if j < n && bytes[j] == b'$' {
        return Some(j);
    }
    if j < n && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'_' || bytes[j] >= 0x80) {
        j += 1;
        while j < n && is_ident_byte(bytes[j]) {
            j += 1;
        }
        if j < n && bytes[j] == b'$' {
            return Some(j);
        }
    }
    None
}

fn skip_dollar_quoted(bytes: &[u8], mut i: usize, tag: &[u8]) -> usize {
    let n = bytes.len();
    while i + tag.len() <= n {
        if &bytes[i..i + tag.len()] == tag {
            return i + tag.len();
        }
        i += 1;
    }
    n
}

// ───────────────────────── keywords ─────────────────────────

const DDL_KEYWORDS: &[&str] = &[
    "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "RENAME", "COMMENT", "REINDEX",
];

/// First keyword of a statement, upper-cased, skipping leading comments and
/// parentheses. Empty when there is none.
pub fn first_keyword(stmt: &str) -> String {
    let bytes = stmt.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    loop {
        while i < n && (bytes[i].is_ascii_whitespace() || bytes[i] == b'(') {
            i += 1;
        }
        if i + 1 < n && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i = skip_line_comment(bytes, i);
            continue;
        }
        if i < n && bytes[i] == b'#' {
            i = skip_line_comment(bytes, i);
            continue;
        }
        if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i = skip_block_comment(bytes, i, true);
            continue;
        }
        break;
    }
    let start = i;
    while i < n && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    stmt[start..i].to_ascii_uppercase()
}

/// Case-insensitive check for a bare `WHERE` keyword outside strings and
/// comments. Used only for the unparsed fallback.
fn contains_where_keyword(kind: DriverKind, stmt: &str) -> bool {
    // Reuse the splitter's scanner by treating the statement as one script:
    // strip strings/comments by walking with the same rules.
    let bytes = stmt.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    let mut word = String::new();
    let backslash = matches!(kind, DriverKind::Mysql);
    while i < n {
        let c = bytes[i];
        let next = if i + 1 < n { bytes[i + 1] } else { 0 };
        if c == b'-' && next == b'-' || (c == b'#' && kind == DriverKind::Mysql) {
            i = skip_line_comment(bytes, i);
        } else if c == b'/' && next == b'*' {
            i = skip_block_comment(bytes, i, kind == DriverKind::Postgres);
        } else if c == b'\'' || c == b'"' || c == b'`' {
            i = skip_quoted(bytes, i, c, backslash && c != b'`');
        } else if c == b'$' && kind == DriverKind::Postgres {
            if let Some(te) = dollar_tag_end(bytes, i) {
                let tag = bytes[i..=te].to_vec();
                i = skip_dollar_quoted(bytes, te + 1, &tag);
            } else {
                i += 1;
            }
        } else if c.is_ascii_alphanumeric() || c == b'_' {
            word.push(c.to_ascii_lowercase() as char);
            i += 1;
            continue;
        } else {
            i += 1;
        }
        if word == "where" {
            return true;
        }
        word.clear();
    }
    word == "where"
}

// ───────────────────────── classification ─────────────────────────

/// Classify a single statement. Parses with `sqlparser`; on failure falls
/// back to the first keyword and sets `parsed = false`.
pub fn classify(kind: DriverKind, stmt: &str) -> Classified {
    let dialect = dialect_for(kind);
    let parsed = Parser::new(dialect.as_ref())
        .try_with_sql(stmt)
        .and_then(|mut p| p.parse_statements())
        .ok()
        .and_then(|mut v| {
            if v.is_empty() {
                None
            } else {
                Some(v.remove(0))
            }
        });

    match parsed {
        Some(ast) => classify_ast(&ast, stmt),
        None => classify_heuristic(kind, stmt),
    }
}

fn classify_ast(ast: &Statement, stmt: &str) -> Classified {
    let mut c = Classified {
        kind: StatementKind::Other,
        parsed: true,
        has_where: None,
        is_explain: false,
    };
    match ast {
        Statement::Query(q) => classify_query(q, &mut c),
        Statement::Insert(_) => c.kind = StatementKind::Insert,
        Statement::Update(u) => {
            c.kind = StatementKind::Update;
            c.has_where = Some(u.selection.is_some());
        }
        Statement::Delete(d) => {
            c.kind = StatementKind::Delete;
            c.has_where = Some(d.selection.is_some());
        }
        Statement::Explain {
            analyze,
            statement,
            options,
            ..
        } => {
            let analyze = *analyze || options_have_analyze(options.as_deref());
            let inner = classify_ast(statement, stmt);
            c.is_explain = true;
            if analyze && inner.kind != StatementKind::Select {
                // EXPLAIN ANALYZE executes the statement.
                c.kind = inner.kind;
                c.has_where = inner.has_where;
            } else {
                c.kind = StatementKind::Select;
            }
        }
        Statement::ExplainTable { .. }
        | Statement::ShowFunctions { .. }
        | Statement::ShowVariable { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowCatalogs { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowProcessList { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowCharset(_)
        | Statement::ShowObjects(_)
        | Statement::ShowTables { .. }
        | Statement::ShowViews { .. }
        | Statement::ShowCollation { .. } => c.kind = StatementKind::Select,
        Statement::Pragma { value, .. } => {
            // `PRAGMA x` reads; `PRAGMA x = v` / `PRAGMA x(v)` writes.
            c.kind = if value.is_none() {
                StatementKind::Select
            } else {
                StatementKind::Other
            };
        }
        Statement::Truncate(_)
        | Statement::Grant(_)
        | Statement::Revoke(_)
        | Statement::RenameTable(_)
        | Statement::Comment { .. }
        | Statement::CreateTable(_)
        | Statement::CreateView(_)
        | Statement::CreateIndex(_)
        | Statement::AlterTable(_)
        | Statement::Drop { .. } => c.kind = StatementKind::Ddl,
        _ => {
            // Every other CREATE/ALTER/DROP variant, plus anything else.
            let kw = first_keyword(stmt);
            c.kind = if DDL_KEYWORDS.contains(&kw.as_str()) {
                StatementKind::Ddl
            } else {
                StatementKind::Other
            };
        }
    }
    c
}

fn options_have_analyze(options: Option<&[ast::UtilityOption]>) -> bool {
    options
        .map(|opts| {
            opts.iter().any(|o| {
                o.name.value.eq_ignore_ascii_case("analyze")
                    && !matches!(
                        o.arg
                            .as_ref()
                            .map(|a| a.to_string().to_ascii_lowercase())
                            .as_deref(),
                        Some("false") | Some("off") | Some("0") | Some("no")
                    )
            })
        })
        .unwrap_or(false)
}

fn classify_query(q: &ast::Query, c: &mut Classified) {
    match q.body.as_ref() {
        SetExpr::Select(s) => {
            // `SELECT … INTO new_table` creates a table.
            c.kind = if s.into.is_some() {
                StatementKind::Ddl
            } else {
                StatementKind::Select
            };
        }
        SetExpr::Query(_)
        | SetExpr::SetOperation { .. }
        | SetExpr::Values(_)
        | SetExpr::Table(_) => {
            c.kind = StatementKind::Select;
        }
        SetExpr::Insert(_) => c.kind = StatementKind::Insert,
        SetExpr::Update(inner) => {
            c.kind = StatementKind::Update;
            c.has_where = match inner {
                Statement::Update(u) => Some(u.selection.is_some()),
                _ => Some(false),
            };
        }
        SetExpr::Delete(inner) => {
            c.kind = StatementKind::Delete;
            c.has_where = match inner {
                Statement::Delete(d) => Some(d.selection.is_some()),
                _ => Some(false),
            };
        }
        SetExpr::Merge(_) => c.kind = StatementKind::Other,
    }
}

fn classify_heuristic(kind: DriverKind, stmt: &str) -> Classified {
    let kw = first_keyword(stmt);
    let mut c = Classified {
        kind: StatementKind::Other,
        parsed: false,
        has_where: None,
        is_explain: false,
    };
    match kw.as_str() {
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC" => {
            c.kind = StatementKind::Select
        }
        "PRAGMA" => {
            // `PRAGMA x = v` assigns; anything else is (probably) a read.
            c.kind = if stmt.contains('=') {
                StatementKind::Other
            } else {
                StatementKind::Select
            };
        }
        "EXPLAIN" => {
            c.kind = StatementKind::Select;
            c.is_explain = true;
        }
        "INSERT" | "REPLACE" => c.kind = StatementKind::Insert,
        "UPDATE" => {
            c.kind = StatementKind::Update;
            c.has_where = Some(contains_where_keyword(kind, stmt));
        }
        "DELETE" => {
            c.kind = StatementKind::Delete;
            c.has_where = Some(contains_where_keyword(kind, stmt));
        }
        k if DDL_KEYWORDS.contains(&k) => c.kind = StatementKind::Ddl,
        _ => {}
    }
    c
}

// ───────────────────────── policy ─────────────────────────

fn describe(c: &Classified, stmt: &str) -> String {
    match c.kind {
        StatementKind::Select => "SELECT".into(),
        StatementKind::Insert => "INSERT".into(),
        StatementKind::Update => "UPDATE".into(),
        StatementKind::Delete => "DELETE".into(),
        StatementKind::Ddl | StatementKind::Other => {
            let kw = first_keyword(stmt);
            if kw.is_empty() {
                "This statement".into()
            } else {
                kw
            }
        }
    }
}

/// Safe mode: the padlock in the toolbar. It is read-only semantics with its
/// own message, because "blocked by read-only policy" would send someone to
/// the connection settings when the answer is one keystroke away.
///
/// Like the read-only policy, an unparseable statement is refused: we cannot
/// call something read-only when we could not read it.
pub fn check_safe_mode(c: &Classified, stmt: &str) -> Result<(), IpcError> {
    if !c.parsed {
        return Err(IpcError::policy(format!(
            "Blocked by safe mode: {} could not be parsed, so it cannot be verified as read-only. Unlock safe mode in the toolbar to run it.",
            describe_lower(c, stmt)
        )));
    }
    match c.kind {
        StatementKind::Select => Ok(()),
        _ => Err(IpcError::policy(format!(
            "Blocked by safe mode: {} is not allowed while the padlock is on. Unlock it in the toolbar to run this.",
            describe(c, stmt)
        ))),
    }
}

/// Enforce `policy` on a classified statement. `Ok(())` means "may execute".
pub fn check(policy: PolicyMode, c: &Classified, stmt: &str) -> Result<(), IpcError> {
    match policy {
        PolicyMode::Full => Ok(()),
        PolicyMode::ReadOnly => {
            if !c.parsed {
                return Err(IpcError::policy(format!(
                    "Blocked by read-only policy: {} could not be parsed, so it cannot be verified as read-only.",
                    describe_lower(c, stmt)
                )));
            }
            match c.kind {
                StatementKind::Select => Ok(()),
                _ => Err(IpcError::policy(format!(
                    "Blocked by read-only policy: {} is not allowed on this connection.",
                    describe(c, stmt)
                ))),
            }
        }
        PolicyMode::ReadWrite => {
            if !c.parsed {
                let kw = first_keyword(stmt);
                if DDL_KEYWORDS.contains(&kw.as_str()) {
                    return Err(IpcError::policy(format!(
                        "Blocked by read-write policy: {kw} is not allowed on this connection. Switch the connection to the full policy to run DDL."
                    )));
                }
                // Unparseable UPDATE/DELETE: still insist on a WHERE token.
                if matches!(c.kind, StatementKind::Update | StatementKind::Delete)
                    && c.has_where == Some(false)
                {
                    return Err(IpcError::policy(format!(
                        "Blocked by read-write policy: {kw} requires a WHERE clause under read-write policy."
                    )));
                }
                return Ok(());
            }
            match c.kind {
                StatementKind::Select | StatementKind::Insert | StatementKind::Other => Ok(()),
                StatementKind::Update | StatementKind::Delete => {
                    if c.has_where == Some(false) {
                        Err(IpcError::policy(format!(
                            "Blocked by read-write policy: {} requires a WHERE clause under read-write policy.",
                            describe(c, stmt)
                        )))
                    } else {
                        Ok(())
                    }
                }
                StatementKind::Ddl => Err(IpcError::policy(format!(
                    "Blocked by read-write policy: {} is not allowed on this connection. Switch the connection to the full policy to run DDL.",
                    describe(c, stmt)
                ))),
            }
        }
    }
}

fn describe_lower(c: &Classified, stmt: &str) -> String {
    let d = describe(c, stmt);
    if d == "This statement" {
        d
    } else {
        format!("this {d} statement")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use DriverKind::*;
    use PolicyMode::*;
    use StatementKind as K;

    fn cls(kind: DriverKind, s: &str) -> Classified {
        classify(kind, s)
    }
    fn allowed(p: PolicyMode, kind: DriverKind, s: &str) -> bool {
        check(p, &cls(kind, s), s).is_ok()
    }
    fn safe_ok(kind: DriverKind, s: &str) -> bool {
        check_safe_mode(&cls(kind, s), s).is_ok()
    }
    fn blocked_msg(p: PolicyMode, kind: DriverKind, s: &str) -> String {
        match check(p, &cls(kind, s), s) {
            Err(e) => {
                assert_eq!(e.code, "policy");
                e.message
            }
            Ok(()) => panic!("expected {s:?} to be blocked under {p:?}"),
        }
    }

    // ── splitting ──

    #[test]
    fn safe_mode_is_read_only_with_its_own_words() {
        use DriverKind::Postgres;
        // Reads are untouched, whatever the connection allows.
        assert!(safe_ok(Postgres, "select * from orders"));
        assert!(safe_ok(Postgres, "with t as (select 1) select * from t"));

        // Everything that writes is refused, and says why in a way that
        // points at the padlock rather than at the connection settings.
        for s in [
            "delete from orders where id = 1",
            "update orders set status = 'x' where id = 1",
            "insert into orders (id) values (1)",
            "drop table orders",
            "truncate orders",
        ] {
            let e = check_safe_mode(&cls(Postgres, s), s).unwrap_err();
            assert_eq!(e.code, "policy", "{s}");
            assert!(e.message.contains("safe mode"), "{s}: {}", e.message);
            assert!(e.message.contains("Unlock"), "{s}: {}", e.message);
        }

        // Unparseable is refused too: we cannot call it read-only when we
        // could not read it.
        assert!(!safe_ok(Postgres, "delete from orders ((("));
        assert!(!safe_ok(Postgres, "frobnicate the thing"));
    }

    #[test]
    fn split_basic() {
        let v = split_statements(Postgres, "select 1; select 2;\n\n  ;select 3");
        assert_eq!(v, vec!["select 1", "select 2", "select 3"]);
    }

    #[test]
    fn split_respects_strings_with_semicolons() {
        let v = split_statements(
            Postgres,
            "select 'a;b'; select 'it''s; fine'; select \"c;d\" from t",
        );
        assert_eq!(
            v,
            vec![
                "select 'a;b'",
                "select 'it''s; fine'",
                "select \"c;d\" from t"
            ]
        );
    }

    #[test]
    fn split_respects_comments() {
        let v = split_statements(
            Postgres,
            "-- first; not a split\nselect 1; /* block ; comment */ select 2; /* nested /* ; */ ; */ select 3",
        );
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], "-- first; not a split\nselect 1");
        assert_eq!(v[1], "/* block ; comment */ select 2");
        assert_eq!(v[2], "/* nested /* ; */ ; */ select 3");
    }

    #[test]
    fn split_drops_comment_only_statements() {
        let v = split_statements(Postgres, "select 1; -- trailing comment\n");
        assert_eq!(v, vec!["select 1"]);
        let v = split_statements(Postgres, "/* just a comment */");
        assert!(v.is_empty());
    }

    #[test]
    fn split_dollar_quotes() {
        let sql = "create function f() returns void as $$ begin perform 1; perform 2; end $$ language plpgsql; select 1; do $tag$ select ';'; $tag$";
        let v = split_statements(Postgres, sql);
        assert_eq!(v.len(), 3);
        assert!(v[0].starts_with("create function"));
        assert!(v[0].ends_with("language plpgsql"));
        assert_eq!(v[1], "select 1");
        assert_eq!(v[2], "do $tag$ select ';'; $tag$");
    }

    #[test]
    fn split_positional_params_are_not_dollar_quotes() {
        let v = split_statements(Postgres, "select $1; select $2");
        assert_eq!(v, vec!["select $1", "select $2"]);
    }

    #[test]
    fn split_mysql_backticks_hash_comments_backslashes() {
        let v = split_statements(
            Mysql,
            "select `a;b` from t; # comment ; here\nselect 'x\\'; y'; select 2",
        );
        assert_eq!(
            v,
            vec![
                "select `a;b` from t",
                "# comment ; here\nselect 'x\\'; y'",
                "select 2"
            ]
        );
    }

    #[test]
    fn split_postgres_backslash_is_literal_unless_e_string() {
        let v = split_statements(Postgres, r"select 'a\'; select 1");
        assert_eq!(v, vec![r"select 'a\'", "select 1"]);
        let v = split_statements(Postgres, r"select E'a\'; b'; select 1");
        assert_eq!(v, vec![r"select E'a\'; b'", "select 1"]);
    }

    #[test]
    fn split_unterminated_string_swallows_rest() {
        let v = split_statements(Sqlite, "select 'oops; select 1");
        assert_eq!(v, vec!["select 'oops; select 1"]);
    }

    #[test]
    fn split_sqlite_brackets() {
        let v = split_statements(Sqlite, "select [a;b] from t; select 1");
        assert_eq!(v, vec!["select [a;b] from t", "select 1"]);
    }

    #[test]
    fn split_preserves_original_text() {
        let s = "SELECT   a,b\n  FROM t -- c\n WHERE x = 1";
        let v = split_statements(Postgres, s);
        assert_eq!(v, vec![s]);
    }

    // ── classification ──

    #[test]
    fn classify_select_forms() {
        for s in [
            "select 1",
            "SELECT * FROM t WHERE id = 1",
            "with x as (select 1) select * from x",
            "values (1), (2)",
            "(select 1) union all (select 2)",
            "explain select 1",
            "explain analyze select 1",
        ] {
            let c = cls(Postgres, s);
            assert_eq!(c.kind, K::Select, "{s}");
            assert!(c.parsed, "{s}");
            assert_eq!(c.has_where, None);
        }
        assert!(cls(Postgres, "explain select 1").is_explain);
        assert!(!cls(Postgres, "select 1").is_explain);
    }

    #[test]
    fn classify_show_describe_pragma() {
        assert_eq!(cls(Mysql, "show tables").kind, K::Select);
        assert_eq!(cls(Mysql, "show create table t").kind, K::Select);
        assert_eq!(cls(Mysql, "describe t").kind, K::Select);
        // sqlparser 0.63 does not parse the call form; it falls back to the
        // keyword heuristic and therefore fails closed under read-only.
        let p = cls(Sqlite, "pragma table_info(t)");
        assert!(!p.parsed);
        assert_eq!(p.kind, K::Select);
        assert!(check(ReadOnly, &p, "pragma table_info(t)").is_err());
        assert_eq!(cls(Sqlite, "pragma foreign_keys").kind, K::Select);
        assert!(cls(Sqlite, "pragma foreign_keys").parsed);
        let w = cls(Sqlite, "pragma journal_mode = 'wal'");
        assert!(w.parsed);
        assert_eq!(w.kind, K::Other);
        let w = cls(Sqlite, "pragma journal_mode = wal");
        assert!(!w.parsed);
        assert_eq!(w.kind, K::Other);
    }

    #[test]
    fn classify_writes() {
        let c = cls(Postgres, "insert into t (a) values (1)");
        assert_eq!(c.kind, K::Insert);
        assert!(c.parsed);

        let c = cls(Postgres, "update t set a = 1 where id = 2");
        assert_eq!(c.kind, K::Update);
        assert_eq!(c.has_where, Some(true));

        let c = cls(Postgres, "update t set a = 1");
        assert_eq!(c.kind, K::Update);
        assert_eq!(c.has_where, Some(false));

        let c = cls(Postgres, "delete from t where id = 2");
        assert_eq!(c.kind, K::Delete);
        assert_eq!(c.has_where, Some(true));

        let c = cls(Postgres, "delete from t");
        assert_eq!(c.kind, K::Delete);
        assert_eq!(c.has_where, Some(false));
    }

    #[test]
    fn classify_cte_writes() {
        let c = cls(Postgres, "with x as (select 1) update t set a = 1");
        assert_eq!(c.kind, K::Update);
        assert_eq!(c.has_where, Some(false));
        let c = cls(
            Postgres,
            "with x as (select 1) delete from t where id in (select * from x)",
        );
        assert_eq!(c.kind, K::Delete);
        assert_eq!(c.has_where, Some(true));
        let c = cls(
            Postgres,
            "with x as (select 1) insert into t select * from x",
        );
        assert_eq!(c.kind, K::Insert);
    }

    #[test]
    fn classify_explain_analyze_of_write_is_the_write() {
        let c = cls(Postgres, "explain analyze update t set a = 1");
        assert_eq!(c.kind, K::Update);
        assert!(c.is_explain);
        assert_eq!(c.has_where, Some(false));
        let c = cls(
            Postgres,
            "explain (analyze, buffers) delete from t where id = 1",
        );
        assert_eq!(c.kind, K::Delete);
        assert_eq!(c.has_where, Some(true));
        let c = cls(Postgres, "explain update t set a = 1");
        assert_eq!(c.kind, K::Select, "plain EXPLAIN never executes");
        assert!(c.is_explain);
    }

    #[test]
    fn classify_ddl() {
        for s in [
            "create table t (id int)",
            "alter table t add column x int",
            "drop table t",
            "truncate table t",
            "grant select on t to bob",
            "revoke select on t from bob",
            "create index i on t (a)",
            "create schema s",
            "drop index i",
            "create or replace function f() returns int language sql as 'select 1'",
            "alter table t rename to u",
            "select * into newt from t",
        ] {
            let c = cls(Postgres, s);
            assert_eq!(c.kind, K::Ddl, "{s}");
        }
        assert_eq!(cls(Mysql, "rename table a to b").kind, K::Ddl);
        assert_eq!(cls(Mysql, "truncate t").kind, K::Ddl);
    }

    #[test]
    fn classify_other() {
        for s in [
            "begin",
            "commit",
            "rollback",
            "set search_path = public",
            "vacuum t",
        ] {
            let c = cls(Postgres, s);
            assert_eq!(c.kind, K::Other, "{s}");
        }
    }

    #[test]
    fn classify_unparseable_falls_back_to_keyword() {
        let c = cls(Postgres, "select from where )(");
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Select);

        let c = cls(Postgres, "frobnicate the database");
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Other);

        let c = cls(
            Postgres,
            "-- leading comment\n/* and */ DROP something weird ((",
        );
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Ddl);

        let c = cls(Mysql, "update t set a = (((");
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Update);
        assert_eq!(c.has_where, Some(false));

        let c = cls(Mysql, "delete from t where a = 'x' and (((");
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Delete);
        assert_eq!(c.has_where, Some(true));

        // "where" inside a string does not count.
        let c = cls(Postgres, "update t set a = 'where' (((");
        assert_eq!(c.has_where, Some(false));

        let c = cls(Postgres, "");
        assert!(!c.parsed);
        assert_eq!(c.kind, K::Other);
    }

    #[test]
    fn first_keyword_skips_comments_and_parens() {
        assert_eq!(first_keyword("  -- x\n /* y */ (select 1)"), "SELECT");
        assert_eq!(first_keyword("UpDaTe t"), "UPDATE");
        assert_eq!(first_keyword("   "), "");
    }

    // ── policy: read-only ──

    #[test]
    fn read_only_allows_reads() {
        for s in [
            "select 1",
            "with x as (select 1) select * from x",
            "values (1)",
            "explain select 1",
            "explain analyze select * from t",
            "(select 1) union (select 2)",
        ] {
            assert!(allowed(ReadOnly, Postgres, s), "{s}");
        }
        assert!(allowed(ReadOnly, Mysql, "show tables"));
        assert!(allowed(ReadOnly, Mysql, "describe t"));
        assert!(allowed(ReadOnly, Mysql, "explain select 1"));
        assert!(allowed(ReadOnly, Sqlite, "pragma foreign_keys"));
        assert!(allowed(ReadOnly, Sqlite, "select * from sqlite_master"));
    }

    #[test]
    fn read_only_blocks_writes_and_ddl() {
        let m = blocked_msg(ReadOnly, Postgres, "update t set a = 1 where id = 1");
        assert_eq!(
            m,
            "Blocked by read-only policy: UPDATE is not allowed on this connection."
        );
        let m = blocked_msg(ReadOnly, Postgres, "insert into t values (1)");
        assert!(m.contains("INSERT is not allowed"));
        let m = blocked_msg(ReadOnly, Postgres, "delete from t where 1=1");
        assert!(m.contains("DELETE is not allowed"));
        let m = blocked_msg(ReadOnly, Postgres, "drop table t");
        assert!(m.contains("DROP is not allowed"));
        let m = blocked_msg(ReadOnly, Postgres, "create table t (a int)");
        assert!(m.contains("CREATE is not allowed"));
        let m = blocked_msg(ReadOnly, Postgres, "truncate t");
        assert!(m.contains("TRUNCATE is not allowed"));
        assert!(!allowed(
            ReadOnly,
            Postgres,
            "with x as (select 1) update t set a = 1 where b = 2"
        ));
        assert!(!allowed(
            ReadOnly,
            Postgres,
            "explain analyze update t set a = 1"
        ));
        assert!(!allowed(ReadOnly, Postgres, "select * into newt from t"));
        assert!(!allowed(ReadOnly, Sqlite, "pragma journal_mode = 'wal'"));
        assert!(!allowed(ReadOnly, Sqlite, "pragma journal_mode = wal"));
    }

    #[test]
    fn read_only_blocks_other() {
        assert!(!allowed(ReadOnly, Postgres, "set search_path = public"));
        assert!(!allowed(ReadOnly, Postgres, "begin"));
        assert!(!allowed(ReadOnly, Postgres, "vacuum t"));
        let m = blocked_msg(ReadOnly, Postgres, "vacuum t");
        assert!(m.contains("VACUUM is not allowed"));
    }

    #[test]
    fn read_only_fails_closed_on_unparseable() {
        let m = blocked_msg(ReadOnly, Postgres, "select from where )(");
        assert!(m.starts_with("Blocked by read-only policy:"), "{m}");
        assert!(m.contains("could not be parsed"), "{m}");
        assert!(!allowed(ReadOnly, Postgres, "frobnicate"));
        assert!(!allowed(ReadOnly, Postgres, ""));
    }

    // ── policy: read-write ──

    #[test]
    fn read_write_allows_reads_and_dml_with_where() {
        for s in [
            "select 1",
            "insert into t (a) values (1)",
            "update t set a = 1 where id = 1",
            "delete from t where id = 1",
            "with x as (select 1) delete from t where id in (select * from x)",
            "explain select 1",
            "begin",
            "commit",
            "set search_path = public",
        ] {
            assert!(allowed(ReadWrite, Postgres, s), "{s}");
        }
    }

    #[test]
    fn read_write_requires_where() {
        let m = blocked_msg(ReadWrite, Postgres, "update t set a = 1");
        assert_eq!(
            m,
            "Blocked by read-write policy: UPDATE requires a WHERE clause under read-write policy."
        );
        let m = blocked_msg(ReadWrite, Postgres, "delete from t");
        assert!(m.contains("DELETE requires a WHERE clause"));
        assert!(!allowed(
            ReadWrite,
            Postgres,
            "with x as (select 1) update t set a = 1"
        ));
        assert!(!allowed(
            ReadWrite,
            Postgres,
            "explain analyze delete from t"
        ));
        // Unparseable UPDATE without WHERE is still caught by the heuristic.
        assert!(!allowed(ReadWrite, Mysql, "update t set a = ((("));
    }

    #[test]
    fn read_write_blocks_ddl() {
        for s in [
            "create table t (a int)",
            "alter table t add column b int",
            "drop table t",
            "truncate t",
            "grant select on t to bob",
            "revoke select on t from bob",
            "select * into newt from t",
        ] {
            let m = blocked_msg(ReadWrite, Postgres, s);
            assert!(m.starts_with("Blocked by read-write policy:"), "{s}: {m}");
            assert!(m.contains("full policy"), "{s}: {m}");
        }
        assert!(!allowed(ReadWrite, Mysql, "rename table a to b"));
    }

    #[test]
    fn read_write_unparseable_allowed_unless_ddl_keyword() {
        assert!(allowed(ReadWrite, Postgres, "select from where )("));
        assert!(allowed(ReadWrite, Postgres, "frobnicate"));
        assert!(!allowed(ReadWrite, Postgres, "drop something ((("));
        assert!(!allowed(ReadWrite, Postgres, "/* c */ ALTER weird ((("));
        assert!(!allowed(ReadWrite, Postgres, "create ((("));
    }

    // ── policy: full ──

    #[test]
    fn full_allows_everything() {
        for s in [
            "select 1",
            "update t set a = 1",
            "delete from t",
            "drop table t",
            "create table t (a int)",
            "frobnicate",
            "",
        ] {
            assert!(allowed(Full, Postgres, s), "{s}");
        }
    }

    #[test]
    fn matrix_each_mode_each_kind() {
        let cases: &[(&str, K, bool, bool, bool)] = &[
            // stmt, kind, read-only ok, read-write ok, full ok
            ("select 1", K::Select, true, true, true),
            ("insert into t values (1)", K::Insert, false, true, true),
            (
                "update t set a = 1 where b = 1",
                K::Update,
                false,
                true,
                true,
            ),
            ("update t set a = 1", K::Update, false, false, true),
            ("delete from t where b = 1", K::Delete, false, true, true),
            ("delete from t", K::Delete, false, false, true),
            ("drop table t", K::Ddl, false, false, true),
            ("begin", K::Other, false, true, true),
        ];
        for (s, kind, ro, rw, full) in cases {
            let c = cls(Postgres, s);
            assert_eq!(c.kind, *kind, "{s}");
            assert_eq!(check(ReadOnly, &c, s).is_ok(), *ro, "{s} read-only");
            assert_eq!(check(ReadWrite, &c, s).is_ok(), *rw, "{s} read-write");
            assert_eq!(check(Full, &c, s).is_ok(), *full, "{s} full");
        }
    }

    #[test]
    fn split_then_classify_multi_statement() {
        let sql = "select 'a;b' as x; -- note; here\nupdate t set a = 1 where id = 1; drop table t";
        let parts = split_statements(Postgres, sql);
        assert_eq!(parts.len(), 3);
        let kinds: Vec<K> = parts.iter().map(|p| cls(Postgres, p).kind).collect();
        assert_eq!(kinds, vec![K::Select, K::Update, K::Ddl]);
    }
}
