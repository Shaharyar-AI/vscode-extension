/** One output channel for the whole extension. */

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("CR-Track");
  return channel;
}

function write(level: string, message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  channel?.appendLine(`${stamp} ${level} ${message}`);
}

export const log = {
  info: (m: string) => write("   ", m),
  warn: (m: string) => write("WARN", m),
  error: (m: string, err?: unknown) => {
    write("ERR ", m);
    if (err instanceof Error && err.stack) write("    ", err.stack);
  },
  show: () => channel?.show(true),
};
