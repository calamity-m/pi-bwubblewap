import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

async function terminalApproval(
  ctx: ExtensionContext,
  capability: string,
  command: string,
): Promise<boolean> {
  return (
    (await ctx.ui.custom<boolean>(
      (tui, theme, keybindings, done) => {
        // Render control characters literally so command content cannot alter the dialog.
        const text = new Text(
          // eslint-disable-next-line no-control-regex -- Escape terminal controls in untrusted command text.
          command.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (char) =>
            char === "\t" ? "    " : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
          ),
          0,
          0,
        );
        const choices = new SelectList(
          [
            { value: "deny", label: "Deny" },
            { value: "allow", label: "Allow once" },
          ],
          2,
          {
            selectedPrefix: (s) => theme.fg("accent", s),
            selectedText: (s) => theme.fg("accent", s),
            description: (s) => theme.fg("muted", s),
            scrollInfo: (s) => theme.fg("dim", s),
            noMatch: (s) => s,
          },
        );
        choices.onSelect = (item) => done(item.value === "allow");
        choices.onCancel = () => done(false);
        let offset = 0;
        let pageSize = 1;
        let lineCount = 1;
        return {
          capturesViewportInput: true,
          render(width) {
            const lines = text.render(width);
            lineCount = lines.length;
            // Reserve space for the heading, position, both choices, and key hints.
            pageSize = Math.max(1, Math.min(12, tui.terminal.rows - 8));
            offset = Math.min(offset, Math.max(0, lineCount - pageSize));
            return [
              theme.fg("accent", `Allow ${capability}?`),
              ...lines.slice(offset, offset + pageSize),
              theme.fg(
                "dim",
                `Command lines ${offset + 1}-${Math.min(offset + pageSize, lineCount)} of ${lineCount} (PgUp/PgDn, Home/End)`,
              ),
              ...choices.render(width),
              theme.fg("dim", "Up/Down: choose · Enter: confirm · Esc: deny"),
            ].map((line) => truncateToWidth(line, width));
          },
          handleInput(data) {
            if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageSize);
            else if (matchesKey(data, "pageDown"))
              offset = Math.min(Math.max(0, lineCount - pageSize), offset + pageSize);
            else if (matchesKey(data, "home")) offset = 0;
            else if (matchesKey(data, "end")) offset = Math.max(0, lineCount - pageSize);
            else if (keybindings.matches(data, "tui.select.cancel")) done(false);
            else choices.handleInput(data);
            tui.requestRender();
          },
          invalidate() {
            text.invalidate();
            choices.invalidate();
          },
        };
      },
      { blocked: { kind: "permission", message: `Allow ${capability}?` } },
    )) === true
  );
}

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
    if (ctx.mode === "tui") return await terminalApproval(ctx, capability, command);
    // RPC clients own their dialog layout and still receive the complete command.
    const choice = await ctx.ui.select(`Allow ${capability} for command: ${command}?`, [
      "Deny",
      "Allow once",
    ]);
    return choice === "Allow once";
  } finally {
    release();
  }
}
