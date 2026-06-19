use zed_extension_api::{
    self as zed, DownloadedFileType, LanguageServerInstallationStatus, Result, current_platform,
    download_file, make_file_executable, serde_json, set_language_server_installation_status,
};

const REPO: &str = "dkoontz/gren-language-server-unofficial";
// const REPO: &str = "lue-bird/gren-language-server-unofficial";

const VERSION: &str = "0.0.2";

const BIN_NAME: &str = "gren-language-server-unofficial";
const DOWNLOAD_DIR: &str = "lsp";

struct GrenUnofficialZedExtension {
    did_attempt_download: bool,
}

impl zed::Extension for GrenUnofficialZedExtension {
    fn new() -> Self {
        GrenUnofficialZedExtension {
            did_attempt_download: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if std::path::Path::new(BIN_NAME).is_file() {
            return Ok(zed::Command::new(BIN_NAME));
        }
        let downloaded_binary = format!("{DOWNLOAD_DIR}/{BIN_NAME}");
        if std::path::Path::new(&downloaded_binary).is_file() {
            return Ok(zed::Command::new(downloaded_binary));
        }
        if let Some(path) = worktree.which(BIN_NAME) {
            return Ok(zed::Command::new(path));
        }

        let (os, arch) = current_platform();
        let target = match (os, arch) {
            (zed::Os::Mac, zed::Architecture::Aarch64) => "aarch64-apple-darwin",
            (zed::Os::Mac, zed::Architecture::X8664) => "x86_64-apple-darwin",
            (zed::Os::Linux, zed::Architecture::X8664) => "x86_64-unknown-linux-musl",
            (zed::Os::Windows, zed::Architecture::X8664) => "x86_64-pc-windows-msvc",
            (zed::Os::Windows, zed::Architecture::Aarch64) => "aarch64-pc-windows-msvc",
            _ => {
                return Err(format!("unsupported platform: {os:?}/{arch:?}").into());
            }
        };

        let (archive_ext, file_type) = if target.contains("windows") {
            ("zip", DownloadedFileType::Zip)
        } else {
            ("tar.gz", DownloadedFileType::GzipTar)
        };
        let url = format!(
            "https://github.com/{REPO}/releases/download/v{VERSION}/{BIN_NAME}-{target}.{archive_ext}"
        );

        if self.did_attempt_download {
            return Err(format!(
                "executable {BIN_NAME} not found in the PATH environment and could not be downloaded"
            ).into());
        }
        self.did_attempt_download = true;

        set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );

        download_file(&url, DOWNLOAD_DIR, file_type)
            .map_err(|e| format!("failed to download language server: {e}"))?;

        make_file_executable(&downloaded_binary)?;

        set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );

        Ok(zed::Command::new(downloaded_binary))
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(None)
    }
}

zed_extension_api::register_extension!(GrenUnofficialZedExtension);
