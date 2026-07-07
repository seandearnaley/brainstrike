import { Bot, Brain, Cloud, Cpu, Globe, Sparkles } from 'lucide-react';

interface ProviderIconProps {
  className?: string;
  style?: React.CSSProperties;
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
