export function calculateDynamicTotal(currentTotal: number, loaded: number): number {
  if (loaded <= currentTotal) {
    return currentTotal;
  }

  const bufferPercentage = 0.25;
  const minBuffer = 500;

  const buffer = Math.max(Math.ceil(loaded * bufferPercentage), minBuffer);

  return loaded + buffer;
}

export function calculateProgressPercentage(loaded: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((loaded / total) * 100);
}
