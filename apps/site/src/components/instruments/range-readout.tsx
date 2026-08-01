export function RangeReadout() {
  return (
    <div className="range-readout">
      <div className="sr-only">
        <p>Selected context ranges, 8.4 thousand tokens:</p>
        <ul>
          <li>src/stream.ts, lines 42 through 118</li>
          <li>src/guards.ts, lines 201 through 276</li>
          <li>tests/runtime.ts, lines 88 through 132</li>
        </ul>
      </div>
      <pre aria-hidden="true">{`┌─ TAPESTRY / 03 RANGES ───────┐
│ src/stream.ts       42—118   │
│ src/guards.ts      201—276   │
│ tests/runtime.ts    88—132   │
└─ 8.4k TOKENS / PRECISE ─────┘`}</pre>
      <div className="query-path">
        <span>GREP</span>
        <i />
        <span>BM25</span>
        <i />
        <span>VECTOR</span>
      </div>
    </div>
  );
}
