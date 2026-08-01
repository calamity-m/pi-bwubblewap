import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../src/register.ts";

export default function (pi: ExtensionAPI): void {
  register(pi);
}
