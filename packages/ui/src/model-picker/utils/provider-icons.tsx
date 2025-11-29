import { Bot, Brain, Cloud, Cpu, Globe, Sparkles } from 'lucide-react';

const PROVIDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  openai: Sparkles,
  anthropic: Brain,
  google: Globe,
  openrouter: Cloud,
  cohere: Cpu,
  voyage: Bot,
};

export function getProviderIcon(providerId: string) {
  return PROVIDER_ICONS[providerId] ?? Bot;
}
