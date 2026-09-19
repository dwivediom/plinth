import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorState, Compartment, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, placeholder as cmPlaceholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, codeFolding, foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { MySQL, PostgreSQL, SQLite, keywordCompletionSource, sql, type SQLDialect, type SQLNamespace } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import type { DriverKind, SchemaGraph, SchemaIndex } from "../../ipc/types";
import { sqlCompletions } from "../../lib/completion";

export interface SqlEditorHandle {
  view: EditorView | null;
  getText(): string;
  getSelection(): { from: number; to: number; text: string };
  getCursor(): number;
  setText(text: string, cursor?: number): void;
  setError(from: number, to: number): void;
  clearError(): void;
  focus(): void;
}

interface Props {
  initialText: string;
  initialCursor?: number;
  driver: DriverKind;
  schema: SchemaIndex | null;
  /** The FK graph, for JOIN completion. */
  graph?: SchemaGraph | null;
  onChange: (text: string, cursor: number) => void;
  onCursor?: (line: number, column: number, offset: number) => void;
  placeholder?: string;
}

const setErrorEffect = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: "cm-err-token" });
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorEffect)) {
        if (!e.value || e.value.to <= e.value.from) deco = Decoration.none;
        else deco = Decoration.set([errorMark.range(e.value.from, e.value.to)]);
      }
    }
    // any edit within the marked range clears it
    if (tr.docChanged && deco.size) {
      let clear = false;
      deco.between(0, tr.newDoc.length, (from, to) => {
        tr.changes.iterChangedRanges((fa, ta) => {
          if (fa <= to && ta >= from) clear = true;
        });
      });
      if (clear) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// One hue per token class, so a statement reads by shape rather than as a
// wall of one colour: what it does, what it names, what the values are.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], class: "tok-kw" },
  { tag: [tags.string, tags.special(tags.string), tags.character], class: "tok-str" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], class: "tok-num" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "tok-cmt" },
  { tag: [tags.function(tags.variableName), tags.function(tags.name), tags.macroName], class: "tok-fn" },
  { tag: [tags.typeName, tags.standard(tags.name), tags.className], class: "tok-type" },
  // lang-sql tags a bare identifier as `name`; without it every table and
  // column in the statement stays default-coloured.
  { tag: [tags.name, tags.variableName, tags.propertyName, tags.attributeName, tags.labelName, tags.quote], class: "tok-name" },
  { tag: [tags.operator, tags.compareOperator, tags.arithmeticOperator, tags.logicOperator], class: "tok-op" },
  { tag: [tags.punctuation, tags.separator, tags.paren, tags.bracket], class: "tok-punct" },
]);

const BRACKETS = "()[]{}";
const bracketMark = [Decoration.mark({ class: "cm-bracket-1" }), Decoration.mark({ class: "cm-bracket-2" }), Decoration.mark({ class: "cm-bracket-3" })];

/**
 * Bracket depth colouring. Forty lines beats a dependency, and the syntax
 * tree is what keeps it honest: a parenthesis inside a string or a comment is
 * punctuation in prose, not structure.
 */
function rainbowBrackets(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    // Depth has to be counted from the start of the document, or a scrolled
    // view would colour the same bracket differently.
    let depth = 0;
    const text = view.state.doc.sliceString(0, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!BRACKETS.includes(ch)) continue;
      const node = tree.resolveInner(i, 1).name;
      if (/String|Comment|LineComment|BlockComment/.test(node)) continue;
      const opening = ch === "(" || ch === "[" || ch === "{";
      const level = opening ? depth++ : Math.max(0, --depth);
      if (i >= from) builder.add(i, i + 1, bracketMark[level % bracketMark.length]);
    }
  }
  return builder.finish();
}

const tableMark = Decoration.mark({ class: "tok-table" });
const columnMark = Decoration.mark({ class: "tok-column" });
const IDENT = /[A-Za-z_][\w$]*/g;

/**
 * Identifiers, coloured from the schema.
 *
 * lang-sql emits no highlight tag for a bare identifier, so every table and
 * column in a statement is default-coloured — which is also why other clients
 * look flat. We know the schema, so we can do better than a parser: a name
 * that *is* a table reads as a table, a name that is a column reads as a
 * column, and anything else (an alias, a literal) stays plain.
 */
function schemaDecorations(view: EditorView, tables: Set<string>, columns: Set<string>): DecorationSet {
  if (!tables.size && !columns.size) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    IDENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT.exec(text))) {
      const at = from + m.index;
      const word = m[0].toLowerCase();
      const isTable = tables.has(word);
      if (!isTable && !columns.has(word)) continue;
      // A word inside a string or comment is prose, not a reference.
      const node = tree.resolveInner(at, 1).name;
      if (/String|Comment/.test(node)) continue;
      builder.add(at, at + m[0].length, isTable ? tableMark : columnMark);
    }
  }
  return builder.finish();
}

function schemaHighlighter(tables: Set<string>, columns: Set<string>) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = schemaDecorations(view, tables, columns);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = schemaDecorations(u.view, tables, columns);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Completion sources, composed explicitly.
 *
 * Registering ours through `languageData` alongside lang-sql's looked right
 * and silently lost: the source ran, produced the join clauses, and none of
 * them reached the popup. `override` is unambiguous — ours first, then the
 * dialect's keywords, which is all lang-sql was contributing that we don't.
 */
function completionExt(driver: DriverKind, schema: SchemaIndex | null, graph: SchemaGraph | null) {
  const dialect: SQLDialect = driver === "mysql" ? MySQL : driver === "sqlite" ? SQLite : PostgreSQL;
  return autocompletion({
    activateOnTyping: true,
    icons: true,
    override: [sqlCompletions({ schema, graph }), keywordCompletionSource(dialect)],
  });
}

/** Lower-cased names of everything the schema index knows. */
function schemaWords(schema: SchemaIndex | null): { tables: Set<string>; columns: Set<string> } {
  const tables = new Set<string>();
  const columns = new Set<string>();
  if (!schema) return { tables, columns };
  for (const s of schema.schemas) {
    if (s.isSystem) continue;
    for (const o of s.objects) tables.add(o.name.toLowerCase());
  }
  for (const c of schema.columns) columns.add(c.column.toLowerCase());
  // A name that is both is a table: the stronger signal wins.
  for (const t of tables) columns.delete(t);
  return { tables, columns };
}

const rainbow = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = rainbowBrackets(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = rainbowBrackets(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * The find/replace panel is themed here, not in a stylesheet: CodeMirror scopes
 * its own panel rules under a generated class (`.ͼ2 .cm-panels`), which outranks
 * a bare selector in a .css file. Inside `EditorView.theme` our rules get the
 * same shape and win on theme-over-baseTheme priority. Note `&light`/`&dark`
 * prefixes are silently dropped here — they only work in `baseTheme`.
 */
const panel: Record<string, Record<string, string>> = {
  ".cm-panels": { background: "var(--window)", color: "var(--label)", borderBottom: "var(--hairline) solid var(--separator)" },
  ".cm-panel.cm-search": { background: "var(--window)", color: "var(--label)", padding: "var(--sp-3) var(--sp-5)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-3)", font: "var(--t-subheadline)" },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel.cm-search input[type=text]": {
    height: "22px",
    minWidth: "150px",
    padding: "0 var(--sp-3)",
    border: "0",
    borderRadius: "6px",
    background: "var(--content)",
    color: "var(--label)",
    font: "var(--t-subheadline)",
    boxShadow: "inset 0 0 0 var(--hairline) var(--label-3)",
    outline: "none",
  },
  ".cm-panel.cm-search input[type=text]:focus-visible": {
    boxShadow: "inset 0 0 0 var(--hairline) var(--label-3), 0 0 0 3.5px color-mix(in srgb, var(--accent) 50%, transparent)",
  },
  ".cm-panel.cm-search button:not([name=close])": {
    height: "22px",
    padding: "0 var(--sp-4)",
    borderRadius: "6px",
    border: "0",
    background: "var(--control)",
    color: "var(--label)",
    font: "var(--t-subheadline)",
    boxShadow: "0 0 0 var(--hairline) var(--separator)",
    cursor: "default",
  },
  ".cm-panel.cm-search button:not([name=close]):hover": { background: "var(--alt-row)" },
  ".cm-panel.cm-search button[name=close]": { color: "var(--label-3)", background: "none", border: "0", fontSize: "16px", padding: "0 var(--sp-2)", cursor: "default" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", color: "var(--label-2)", font: "var(--t-caption)" },
  ".cm-panel.cm-search label input": { accentColor: "var(--accent)" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--yellow) 30%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { background: "color-mix(in srgb, var(--accent) 40%, transparent)" },
  ".cm-selectionMatch": { background: "color-mix(in srgb, var(--accent) 16%, transparent)", borderRadius: "2px" },
};

const theme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ...panel,
});

function schemaNamespace(schema: SchemaIndex | null): SQLNamespace {
  const ns: Record<string, string[]> = {};
  if (!schema) return ns;
  const byTable = new Map<string, string[]>();
  for (const c of schema.columns) {
    const k = `${c.schema}.${c.table}`;
    if (!byTable.has(k)) byTable.set(k, []);
    byTable.get(k)!.push(c.column);
  }
  for (const s of schema.schemas) {
    if (s.isSystem) continue;
    for (const o of s.objects) {
      if (o.kind === "function" || o.kind === "sequence") continue;
      const cols = byTable.get(`${s.name}.${o.name}`) ?? [];
      ns[`${s.name}.${o.name}`] = cols;
      if (s.name === "public" || s.name === "main") ns[o.name] = cols;
    }
  }
  return ns;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({ initialText, initialCursor, driver, schema, graph, onChange, onCursor, placeholder }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useMemo(() => new Compartment(), []);
  const schemaCompartment = useMemo(() => new Compartment(), []);
  const completionCompartment = useMemo(() => new Compartment(), []);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  const langExt = (s: SchemaIndex | null): Extension =>
    sql({ dialect: driver === "mysql" ? MySQL : driver === "sqlite" ? SQLite : PostgreSQL, schema: schemaNamespace(s), upperCaseKeywords: true, defaultSchema: driver === "sqlite" ? "main" : "public" });

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: initialText,
      selection: { anchor: Math.min(initialCursor ?? initialText.length, initialText.length) },
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rainbow,
        indentationMarkers({ hideFirstIndent: true, highlightActiveBlock: true, colors: { light: "var(--separator)", dark: "var(--separator)", activeLight: "var(--label-4)", activeDark: "var(--label-4)" } }),
        codeFolding(),
        foldGutter(),
        // Multi-cursor (⌥click, ⌘D) and ⌥-drag column selection.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        search({ top: true }),
        history(),
        bracketMatching(),
        closeBrackets(),
        completionCompartment.of(completionExt(driver, schema, graph ?? null)),
        langCompartment.of(langExt(schema)),
        schemaCompartment.of(schemaHighlighter(schemaWords(schema).tables, schemaWords(schema).columns)),
        syntaxHighlighting(highlight),
        errorField,
        theme,
        cmPlaceholder(placeholder ?? "select … ;"),
        EditorView.lineWrapping,
        // searchKeymap before defaultKeymap: ⌘D must select the next occurrence.
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString(), u.state.selection.main.head);
          if (u.selectionSet || u.docChanged) {
            const pos = u.state.selection.main.head;
            const line = u.state.doc.lineAt(pos);
            onCursorRef.current?.(line.number, pos - line.from + 1, pos);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    const line = state.doc.lineAt(state.selection.main.head);
    onCursorRef.current?.(line.number, state.selection.main.head - line.from + 1, state.selection.main.head);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const words = schemaWords(schema);
    viewRef.current?.dispatch({
      effects: [
        langCompartment.reconfigure(langExt(schema)),
        schemaCompartment.reconfigure(schemaHighlighter(words.tables, words.columns)),
        completionCompartment.reconfigure(completionExt(driver, schema, graph ?? null)),
      ],
    });
    // `graph` matters too: it arrives after the first render, and without it
    // in the deps the JOIN completions would never be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, driver, graph]);

  useImperativeHandle(ref, () => ({
    get view() {
      return viewRef.current;
    },
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    getSelection: () => {
      const v = viewRef.current;
      if (!v) return { from: 0, to: 0, text: "" };
      const { from, to } = v.state.selection.main;
      return { from, to, text: v.state.sliceDoc(from, to) };
    },
    getCursor: () => viewRef.current?.state.selection.main.head ?? 0,
    setText(text, cursor) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: Math.min(cursor ?? text.length, text.length) } });
    },
    setError(from, to) {
      viewRef.current?.dispatch({ effects: setErrorEffect.of({ from, to }) });
    },
    clearError() {
      viewRef.current?.dispatch({ effects: setErrorEffect.of(null) });
    },
    focus: () => viewRef.current?.focus(),
  }));

  return <div ref={host} className="editor-host" />;
});
