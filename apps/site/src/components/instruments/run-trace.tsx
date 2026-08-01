export function RunTrace() {
  return (
    <div className="run-trace">
      <div className="trace-header">
        <span>RUN / 019F_B3A2</span>
        <span>INSPECTABLE</span>
      </div>
      <ol>
        <li>
          <time>00:00.218</time>
          <span>memory.history.loaded</span>
          <em>12 messages</em>
        </li>
        <li>
          <time>00:01.042</time>
          <span>tool.approval.requested</span>
          <em className="trace-warn">held</em>
        </li>
        <li>
          <time>00:03.881</time>
          <span>tool.completed</span>
          <em>visible</em>
        </li>
        <li>
          <time>00:04.290</time>
          <span>outcome</span>
          <em className="trace-ok">succeeded</em>
        </li>
      </ol>
    </div>
  );
}
