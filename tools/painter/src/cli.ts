// Command-line validation shared by the painter's entry points.

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function positiveInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return n;
}
