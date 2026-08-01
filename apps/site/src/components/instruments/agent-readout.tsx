export function AgentReadout() {
  return (
    <div className="agent-readout">
      <div className="agent-row agent-row-primary">
        <span>00</span>
        <strong>ORCHESTRATOR</strong>
        <em>ACTIVE</em>
      </div>
      <div className="agent-branches">
        <div>
          <span>01</span>
          <strong>RESEARCH</strong>
          <small>tools: 04</small>
        </div>
        <div>
          <span>02</span>
          <strong>REVIEW</strong>
          <small>model: pinned</small>
        </div>
        <div>
          <span>03</span>
          <strong>USER PERSONA</strong>
          <small>.brainstrike/agents</small>
        </div>
      </div>
    </div>
  );
}
