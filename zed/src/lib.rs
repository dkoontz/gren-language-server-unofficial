use zed_extension_api::{
    self as zed, DownloadedFileType, LanguageServerInstallationStatus, Result, current_platform,
    download_file, make_file_executable, serde_json, set_language_server_installation_status,
};

const REPO: &str = "dkoontz/gren-language-server-unofficial";
// const REPO: &str = "lue-bird/gren-language-server-unofficial";

const VERSION: &str = "0.0.2";

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
        let binary_path = "gren-language-server-unofficial";
        if std::path::Path::new(binary_path).exists() {
            return Ok(zed::Command::new(binary_path));
        }
        if let Some(path) = worktree.which("gren-language-server-unofficial") {
            return Ok(zed::Command::new(path));
        }
        if self.did_attempt_download {
            return Err("executable gren-language-server-unofficial not found in the PATH environment and could not be downloaded".into());
        }
        self.did_attempt_download = true;

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

        set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let archive_ext = if target.contains("windows") {
            "zip"
        } else {
            "tar.gz"
        };
        let url = format!(
            "https://github.com/{REPO}/releases/download/v{VERSION}/gren-language-server-unofficial-{target}.{archive_ext}"
        );

        download_file(&url, binary_path, DownloadedFileType::GzipTar)
            .map_err(|e| format!("failed to download language server: {e}"))?;

        make_file_executable(binary_path)?;

        set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );

        Ok(zed::Command::new(binary_path.to_string()))
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
