export const modelRoute = (label: string): string =>
  label
    .normalize('NFKD')
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const clampVoxelSize = (
  value: number,
  fallback: number,
  range: { min: number; max: number },
): number => Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? value : fallback));
