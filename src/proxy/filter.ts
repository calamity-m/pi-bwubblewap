export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function matchesDomain(host: string, pattern: string): boolean {
  const value = normalizeHost(host);
  const candidate = normalizeHost(pattern);
  if (candidate.startsWith("*.")) {
    const suffix = candidate.slice(1);
    return value.endsWith(suffix) && value.length > suffix.length;
  }
  return value === candidate;
}

export function isAllowedTarget(
  host: string,
  port: number,
  domains: readonly string[],
  ports: readonly number[],
): boolean {
  return ports.includes(port) && domains.some((pattern) => matchesDomain(host, pattern));
}
