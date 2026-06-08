import * as vscode from "vscode";
import { LanguageClientOptions } from "vscode-languageclient";
import { LanguageClient, ServerOptions } from "vscode-languageclient/node";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { createGunzip } from "node:zlib";

const REPO = "dkoontz/gren-language-server-unofficial";
// const REPO = "lue-bird/gren-language-server-unofficial";

let client: LanguageClient | null = null;

function getTarget(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64")
    return "aarch64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64")
    return "x86_64-unknown-linux-musl";
  return null;
}

function getBinaryName(target: string): string {
  return target.includes("windows")
    ? "gren-language-server-unofficial.exe"
    : "gren-language-server-unofficial";
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (url: string) => {
      https
        .get(url, { headers: { "User-Agent": "gren-lsp" } }, (response) => {
          if (
            (response.statusCode === 301 || response.statusCode === 302) &&
            response.headers.location
          ) {
            follow(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", (err) => {
          try {
            fs.unlinkSync(dest);
          } catch {}
          reject(err);
        });
    };
    follow(url);
  });
}

async function ensureServerBinary(
  context: vscode.ExtensionContext,
): Promise<string> {
  const target = getTarget();
  if (!target) {
    return "gren-language-server-unofficial";
  }

  const version: string = context.extension.packageJSON.version;
  const storageDir = context.globalStorageUri.fsPath;
  const binaryName = getBinaryName(target);
  const binaryPath = path.join(storageDir, binaryName);
  const versionPath = path.join(storageDir, "version");

  if (fs.existsSync(binaryPath) && fs.existsSync(versionPath)) {
    const storedVersion = fs.readFileSync(versionPath, "utf-8").trim();
    if (storedVersion === version) {
      return binaryPath;
    }
  }

  fs.mkdirSync(storageDir, { recursive: true });

  const archiveExt = target.includes("windows") ? "zip" : "tar.gz";
  const url = `https://github.com/${REPO}/releases/download/v${version}/gren-language-server-unofficial-${target}.${archiveExt}`;
  const archivePath = path.join(storageDir, `archive.${archiveExt}`);

  try {
    await downloadFile(url, archivePath);
  } catch {
    return "gren-language-server-unofficial";
  }

  if (target.includes("windows")) {
    child_process.execSync(
      `powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${storageDir}' -Force"`,
      { windowsHide: true },
    );
  } else {
    child_process.execSync(`tar xzf '${archivePath}' -C '${storageDir}'`);
    child_process.execSync(`chmod +x '${binaryPath}'`);
    if (process.platform === "darwin") {
      try {
        child_process.execSync(`xattr -cr '${binaryPath}'`);
      } catch {}
    }
  }

  try {
    fs.unlinkSync(archivePath);
  } catch {}
  fs.writeFileSync(versionPath, version);

  return binaryPath;
}

class GrenPkgContentProvider implements vscode.TextDocumentContentProvider {
  private cache = new Map<string, string>();

  async provideTextDocumentContent(
    uri: vscode.Uri,
  ): Promise<string> {
    const cached = this.cache.get(uri.toString());
    if (cached !== undefined) {
      return cached;
    }

    const packageName = uri.authority;
    const moduleName = uri.path.startsWith("/")
      ? uri.path.slice(1)
      : uri.path;

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      const grenPackagesDir = path.join(
        workspaceFolder.uri.fsPath,
        "gren_packages",
      );
      const pkgGzPath = await this.findPkgGz(grenPackagesDir, packageName);
      if (pkgGzPath === null) {
        continue;
      }

      const sources = await this.readPkgGzSources(pkgGzPath);
      if (sources === null) {
        continue;
      }

      for (const [name, source] of Object.entries(sources)) {
        this.cache.set(
          `gren-pkg://${packageName}/${name}`,
          source,
        );
      }

      const source = sources[moduleName];
      if (source !== undefined) {
        return source;
      }
    }

    return `// Module ${moduleName} not found in package ${packageName}`;
  }

  private async findPkgGz(
    grenPackagesDir: string,
    packageName: string,
  ): Promise<string | null> {
    const namePrefix = packageName.replace(/[./]/g, "_") + "__";
    let entries: string[];
    try {
      entries = fs.readdirSync(grenPackagesDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.startsWith(namePrefix) && entry.endsWith(".pkg.gz")) {
        return path.join(grenPackagesDir, entry);
      }
    }
    return null;
  }

  private readPkgGzSources(pkgGzPath: string): Promise<{
    [key: string]: string;
  } | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      fs.createReadStream(pkgGzPath)
        .pipe(createGunzip())
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            resolve(json.sources ?? null);
          } catch {
            resolve(null);
          }
        })
        .on("error", () => resolve(null));
    });
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand("gren.commands.restart", async () => {
      if (client !== null) {
        await client.stop();
        await client.start();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "gren-pkg",
      new GrenPkgContentProvider(),
    ),
  );

  const languageServerExecutableName = await ensureServerBinary(context);

  const serverOptions: ServerOptions = async () => {
    return child_process.spawn(languageServerExecutableName, []);
  };
  const clientOptions: LanguageClientOptions = {
    diagnosticCollectionName: "gren",
    documentSelector: [
      {
        scheme: "file",
        language: "gren",
      },
      {
        scheme: "file",
        language: "json",
      },
      {
        scheme: "gren-pkg",
        language: "gren",
      },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/{gren.json,*.gren}",
      ),
      // documentation says this is deprecated but how else
      // would you get the client to ping on configuration changes?
      configurationSection: "gren-language-server-unofficial",
    },
    // technically not necessary but saves an unnecessary roundtrip
    initializationOptions: getSettings(
      vscode.workspace
        .getConfiguration()
        .get<IClientSettings>("gren-language-server-unofficial"),
    ),
  };
  client = new LanguageClient(
    "gren-language-server-unofficial",
    "gren",
    serverOptions,
    clientOptions,
  );
  await client.start();
}
function getSettings(config: IClientSettings | undefined): object {
  return config
    ? {
        grenPath: config.grenPath,
        grenFormatPath: config.grenFormatPath,
      }
    : {};
}
export interface IClientSettings {
  grenFormatPath: "builtin" | string;
  grenPath: string;
}

export function deactivate(): Thenable<void> | undefined {
  if (client !== null) {
    return client.stop();
  }
  return undefined;
}
