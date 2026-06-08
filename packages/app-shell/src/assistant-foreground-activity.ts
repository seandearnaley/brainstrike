let activeCount = 0;

export function getAssistantForegroundActivitySnapshot(): boolean {
  return activeCount > 0;
}

export function acquireAssistantForegroundActivity(): () => void {
  let released = false;
  activeCount += 1;

  return () => {
    if (released) {
      return;
    }
    released = true;
    activeCount = Math.max(0, activeCount - 1);
  };
}

export function __resetAssistantForegroundActivityForTests(): void {
  activeCount = 0;
}
