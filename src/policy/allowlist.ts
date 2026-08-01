const OPERATORS = ["&&", "||", "|", ";", "\n", "\r", "$(", "`", "&", ">", "<"];

export function containsShellOperator(command: string): boolean {
  return OPERATORS.some((operator) => command.includes(operator));
}

export function matchesUnsandboxedCommand(command: string, patterns: readonly string[]): boolean {
  if (containsShellOperator(command)) return false;
  const value = command.trim();
  return patterns.some((pattern) => {
    const candidate = pattern.trim();
    if (!candidate || candidate === "*") return false;
    if (candidate.endsWith("*")) return value.startsWith(candidate.slice(0, -1));
    return value === candidate;
  });
}
