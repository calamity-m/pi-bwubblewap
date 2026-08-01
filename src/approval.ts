import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let approvalTail: Promise<void> = Promise.resolve();

export async function requestApproval(
  ctx: ExtensionContext,
  capability: string,
  command: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const previous = approvalTail;
  let release!: () => void;
  approvalTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const choice = await ctx.ui.select(`Allow ${capability} for command: ${command}?`, [
      "Deny",
      "Allow once",
    ]);
    return choice === "Allow once";
  } finally {
    release();
  }
}
