import { Bot, Brain, Cloud, Cpu, Globe, Sparkles } from 'lucide-react';

interface ProviderIconProps {
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Amazon Bedrock (BST-1350): inline SVG per the repo's brand-icon convention
 * (no lucide brand icons). A neutral layered-stack "bedrock" glyph drawn in
 * currentColor — pair it with the AWS-orange PROVIDER_COLOR_MAP entry.
 */
function BedrockIcon({
  className,
  style,
}: {
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      style={style}
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 2 3 7l9 5 9-5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

export function ProviderIcon({
  providerId,
  className,
  style,
}: ProviderIconProps & { providerId: string }) {
  if (providerId === 'openai') {
    return <Sparkles className={className} style={style} />;
  }
  if (providerId === 'anthropic') {
    return <Brain className={className} style={style} />;
  }
  if (providerId === 'google') {
    return <Globe className={className} style={style} />;
  }
  if (providerId === 'openrouter') {
    return <Cloud className={className} style={style} />;
  }
  if (providerId === 'cohere') {
    return <Cpu className={className} style={style} />;
  }
  if (providerId === 'voyage') {
    return <Bot className={className} style={style} />;
  }
  if (providerId === 'bedrock') {
    return <BedrockIcon className={className} style={style} />;
  }
  return <Bot className={className} style={style} />;
}

/** @deprecated Use ProviderIcon component instead */
export function getProviderIcon(
  providerId: string
): React.ComponentType<{ className?: string; style?: React.CSSProperties }> {
  const icons: Record<
    string,
    React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  > = {
    anthropic: Brain,
    bedrock: BedrockIcon,
    cohere: Cpu,
    google: Globe,
    openai: Sparkles,
    openrouter: Cloud,
    voyage: Bot,
  };
  return icons[providerId] ?? Bot;
}

/** @deprecated Use ProviderIcon component instead */
export function renderProviderIcon(
  providerId: string,
  props: { className?: string; style?: React.CSSProperties }
) {
  return <ProviderIcon providerId={providerId} {...props} />;
}
