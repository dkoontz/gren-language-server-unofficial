/**
 * Formatter regression tests for the builtin gren formatter.
 *
 * Speaks LSP over stdio to a freshly built language server binary and formats
 * every module in tests/format/project/src. The formatted output must match the
 * snapshot in tests/format/expected (same file name). Each case then formats
 * the formatted output once more to check that formatting is stable.
 *
 * Usage:
 *   node tests/format/runFormatTests.ts
 *   node tests/format/runFormatTests.ts --update   rewrite snapshots
 *
 * The binary defaults to <repo>/target/debug/gren-language-server-unofficial;
 * override with the GREN_LSP_BIN environment variable.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const PROJECT_DIR = join(SCRIPT_DIR, "project");
const SOURCE_DIR = join(PROJECT_DIR, "src");
const EXPECTED_DIR = join(SCRIPT_DIR, "expected");
const UPDATE = process.argv.includes("--update");
const SERVER_STDERR_LINES_ON_FAILURE = 40;
const WATCHDOG_MILLISECONDS = 120_000;

interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class TestFailure extends Error {}

function findBinary(): string {
  const binary =
    process.env.GREN_LSP_BIN ??
    join(REPO_ROOT, "target", "debug", "gren-language-server-unofficial");
  if (!existsSync(binary)) {
    throw new TestFailure(
      `language server binary not found at ${binary}; run \`cargo build\` first` +
        " or set GREN_LSP_BIN",
    );
  }
  return binary;
}

function diffLines(
  expected: string[],
  actual: string[],
): string {
  const expectedLineCount = expected.length;
  const actualLineCount = actual.length;
  // longest common subsequence lengths: suffixLengths[i][j] for expected[i..], actual[j..]
  const suffixLengths: number[][] = Array.from(
    { length: expectedLineCount + 1 },
    () => new Array<number>(actualLineCount + 1).fill(0),
  );
  for (let i = expectedLineCount - 1; i >= 0; i -= 1) {
    for (let j = actualLineCount - 1; j >= 0; j -= 1) {
      suffixLengths[i][j] =
        expected[i] === actual[j]
          ? suffixLengths[i + 1][j + 1] + 1
          : Math.max(suffixLengths[i + 1][j], suffixLengths[i][j + 1]);
    }
  }
  const lines: string[] = ["--- expected", "+++ formatted"];
  let i = 0;
  let j = 0;
  while (i < expectedLineCount && j < actualLineCount) {
    if (expected[i] === actual[j]) {
      lines.push("  " + expected[i]);
      i += 1;
      j += 1;
    } else if (suffixLengths[i + 1][j] >= suffixLengths[i][j + 1]) {
      lines.push("- " + expected[i]);
      i += 1;
    } else {
      lines.push("+ " + actual[j]);
      j += 1;
    }
  }
  while (i < expectedLineCount) {
    lines.push("- " + expected[i]);
    i += 1;
  }
  while (j < actualLineCount) {
    lines.push("+ " + actual[j]);
    j += 1;
  }
  return lines.join("\n");
}

function describeDiff(expected: string, actual: string): string {
  return diffLines(expected.split("\n"), actual.split("\n"));
}

class LanguageServer {
  private readonly process: ReturnType<typeof spawn>;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queuedMessages: LspMessage[] = [];
  private readWaiter: {
    resolve: (message: LspMessage) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly stderrChunks: Buffer[] = [];
  private nextRequestId = 1;
  private answeredConfiguration = false;

  constructor(binaryPath: string) {
    this.process = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = this.process.stdout;
    const stderr = this.process.stderr;
    if (stdout === null || stderr === null) {
      throw new TestFailure("could not open pipes to the language server");
    }
    stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    stdout.on("end", () => this.rejectPendingRead());
    stdout.on("error", () => this.rejectPendingRead());
    stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      let contentLength = 0;
      for (const headerLine of headerText.split("\r\n")) {
        const separatorIndex = headerLine.indexOf(":");
        if (separatorIndex < 0) {
          continue;
        }
        const name = headerLine.slice(0, separatorIndex).trim().toLowerCase();
        if (name === "content-length") {
          contentLength = Number.parseInt(
            headerLine.slice(separatorIndex + 1).trim(),
            10,
          );
        }
      }
      const bodyStart = headerEnd + 4;
      if (!(contentLength > 0) || this.buffer.length < bodyStart + contentLength) {
        return;
      }
      const body = this.buffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      const message = JSON.parse(body) as LspMessage;
      if (this.readWaiter === null) {
        this.queuedMessages.push(message);
      } else {
        const waiter = this.readWaiter;
        this.readWaiter = null;
        waiter.resolve(message);
      }
    }
  }

  private rejectPendingRead(): void {
    if (this.readWaiter !== null) {
      const waiter = this.readWaiter;
      this.readWaiter = null;
      waiter.reject(
        new TestFailure("language server closed the connection"),
      );
    }
  }

  private readMessage(): Promise<LspMessage> {
    const queued = this.queuedMessages.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.readWaiter !== null) {
      return Promise.reject(new Error("concurrent reads are not supported"));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.readWaiter = { resolve: resolvePromise, reject: rejectPromise };
    });
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.process.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin?.write(body);
  }

  private handleServerMessage(message: LspMessage): void {
    if (message.method === "workspace/configuration" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [null, null] });
      this.answeredConfiguration = true;
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.send({ jsonrpc: "2.0", id: requestId, method, params });
    while (true) {
      const message = await this.readMessage();
      this.handleServerMessage(message);
      if (message.id === requestId) {
        if (message.error !== undefined) {
          throw new TestFailure(`${method} failed: ${JSON.stringify(message.error)}`);
        }
        return message.result;
      }
    }
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(workspaceFolder: string): Promise<void> {
    const initializeId = this.nextRequestId;
    this.nextRequestId += 1;
    this.send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        capabilities: {},
        workspaceFolders: [
          { uri: "file://" + workspaceFolder, name: "format-tests" },
        ],
      },
    });
    while (true) {
      const message = await this.readMessage();
      this.handleServerMessage(message);
      if (message.id === initializeId && message.result !== undefined) {
        break;
      }
    }
    // lsp_server's initialize_finish blocks on the client's `initialized`
    // notification before the server sends its workspace/configuration request
    this.notify("initialized", {});
    // answering the configuration request triggers the project scan
    while (!this.answeredConfiguration) {
      this.handleServerMessage(await this.readMessage());
    }
  }

  async format(documentUri: string): Promise<string> {
    const edits = (await this.request("textDocument/formatting", {
      textDocument: { uri: documentUri },
      options: { tabSize: 4, insertSpaces: true },
    })) as Array<{ newText: string }> | null;
    if (edits === null || edits.length === 0) {
      throw new TestFailure("formatting returned no edits");
    }
    return edits[0]!.newText;
  }

  stderrTail(): string {
    const lines = Buffer.concat(this.stderrChunks).toString("utf8").split("\n");
    return lines.slice(-SERVER_STDERR_LINES_ON_FAILURE - 1).join("\n");
  }

  stop(): void {
    this.process.kill();
  }
}

async function runCase(server: LanguageServer, casePath: string): Promise<string> {
  const source = readFileSync(casePath, "utf8");
  const documentUri = "file://" + casePath;
  server.notify("textDocument/didOpen", {
    textDocument: {
      uri: documentUri,
      languageId: "gren",
      version: 1,
      text: source,
    },
  });
  const formatted = await server.format(documentUri);
  // formatting the formatted output must be a no-op (formatting is stable)
  server.notify("textDocument/didChange", {
    textDocument: { uri: documentUri, version: 2 },
    contentChanges: [{ text: formatted }],
  });
  const formattedTwice = await server.format(documentUri);
  if (formattedTwice !== formatted) {
    throw new TestFailure(
      "formatting is not stable (formatting the formatted output" +
        " changed it again):\n" + describeDiff(formatted, formattedTwice),
    );
  }
  return formatted;
}

async function main(): Promise<number> {
  const watchdog = setTimeout(() => {
    console.error(`format tests timed out after ${WATCHDOG_MILLISECONDS / 1000} s`);
    process.exit(1);
  }, WATCHDOG_MILLISECONDS);
  let binary: string;
  try {
    binary = findBinary();
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : failure);
    return 1;
  }
  const casePaths = readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".gren"))
    .sort()
    .map((name) => join(SOURCE_DIR, name));
  if (casePaths.length === 0) {
    console.error(`no .gren cases found in ${SOURCE_DIR}`);
    return 1;
  }
  const server = new LanguageServer(binary);
  const failures: string[] = [];
  let stderrTail = "";
  try {
    await server.initialize(PROJECT_DIR);
    for (const casePath of casePaths) {
      const caseName = casePath.split("/").pop() as string;
      const expectedPath = join(EXPECTED_DIR, caseName);
      try {
        const formatted = await runCase(server, casePath);
        if (UPDATE || !existsSync(expectedPath)) {
          writeFileSync(expectedPath, formatted);
          console.log(`UPDATED ${caseName}`);
          continue;
        }
        const expected = readFileSync(expectedPath, "utf8");
        if (formatted === expected) {
          console.log(`ok       ${caseName}`);
        } else {
          console.log(`FAIL     ${caseName}`);
          failures.push(`${caseName}:\n${describeDiff(expected, formatted)}`);
        }
      } catch (failure) {
        console.log(`FAIL     ${caseName}`);
        failures.push(
          `${caseName}: ${failure instanceof Error ? failure.message : failure}`,
        );
      }
    }
    stderrTail = server.stderrTail();
  } finally {
    server.stop();
    clearTimeout(watchdog);
  }
  if (failures.length > 0) {
    console.log();
    for (const failure of failures) {
      console.log(failure);
      console.log();
    }
    console.log(`${failures.length} of ${casePaths.length} cases failed`);
    console.log("language server stderr (tail):");
    console.log(stderrTail);
    return 1;
  }
  const mode = UPDATE ? "updated" : "passed";
  console.log(`\nall ${casePaths.length} cases ${mode}`);
  return 0;
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
