import { Copy, KeyRound } from "lucide-react";
import type { TableSchema } from "../../ipc/types";
import { toast } from "../../state/overlays";
import { useWorkspaces } from "../../state/workspaces";

export function StructureView({ workspaceId, schema, loading, error }: { workspaceId: string; schema: TableSchema | null; loading: boolean; error: string | null }) {
  const openObject = useWorkspaces((s) => s.openObject);
  if (error) return <div className="empty error-text">{error}</div>;
  if (!schema) return <div className="empty">{loading ? "Loading structure…" : "No structure"}</div>;
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast("Copied DDL"));
  return (
    <div className="structure">
      <section>
        <h3>
          Columns <span className="tertiary">{schema.columns.length}</span>
        </h3>
        <table>
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((c) => (
              <tr key={c.name}>
                <td>
                  {c.isPrimaryKey && (
                    <span className="pk" title="Primary key">
                      <KeyRound />
                    </span>
                  )}
                </td>
                <td>{c.name}</td>
                <td className="mono">{c.dataType}</td>
                <td className="secondary">{c.nullable ? "yes" : "no"}</td>
                <td className="mono secondary">{c.default ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {schema.indexes.length > 0 && (
        <section>
          <h3>Indexes</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
              </tr>
            </thead>
            <tbody>
              {schema.indexes.map((i) => (
                <tr key={i.name}>
                  <td>{i.name}</td>
                  <td className="mono">{i.columns.join(", ")}</td>
                  <td className="secondary">{i.primary ? "primary" : i.unique ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {schema.foreignKeys.length > 0 && (
        <section>
          <h3>Foreign keys</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {schema.foreignKeys.map((fk, i) => (
                <tr key={fk.name ?? i}>
                  <td>{fk.name ?? "—"}</td>
                  <td className="mono">{fk.columns.join(", ")}</td>
                  <td className="mono">
                    <button className="fk-link" onClick={() => openObject(workspaceId, { schema: fk.refTable.schema, name: fk.refTable.name, kind: "table" })}>
                      {fk.refTable.schema ? `${fk.refTable.schema}.` : ""}
                      {fk.refTable.name}
                    </button>{" "}
                    ({fk.refColumns.join(", ")})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {schema.ddl && (
        <section>
          <h3>
            DDL
            <button className="btn mini" onClick={() => copy(schema.ddl!)}>
              <Copy style={{ width: 11, height: 11 }} /> Copy
            </button>
          </h3>
          <pre>{schema.ddl}</pre>
        </section>
      )}
    </div>
  );
}
