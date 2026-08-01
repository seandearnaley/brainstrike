export function ContextReadout() {
  return (
    <section aria-label="Workspace context readout" className="instrument-readout">
      <div className="readout-head">
        <span>CONTEXT BUS</span>
        <span className="readout-live">● LIVE</span>
      </div>
      <ol className="context-lines">
        <li>
          <span>01</span>
          <code>workspace://brainstrike</code>
          <em>MOUNTED</em>
        </li>
        <li>
          <span>02</span>
          <code>assistant-runtime.ts:L318—402</code>
          <em>RANGE</em>
        </li>
        <li>
          <span>03</span>
          <code>semantic + exact</code>
          <em>INDEXED</em>
        </li>
      </ol>
    </section>
  );
}
