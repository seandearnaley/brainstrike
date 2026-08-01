export function ModelMatrix() {
  return (
    <div className="model-matrix">
      <div className="matrix-column">
        <span>HOSTED</span>
        <strong>OpenAI</strong>
        <strong>Anthropic</strong>
        <strong>Google</strong>
        <strong>OpenRouter</strong>
      </div>
      <div className="matrix-divider" />
      <div className="matrix-column">
        <span>LOCAL</span>
        <strong>Built-in local</strong>
        <strong>Ollama</strong>
        <strong>LM Studio</strong>
        <small>capability detected</small>
      </div>
    </div>
  );
}
