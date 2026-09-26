# Development tasks for the gren language server.
#
# `just bump-version X.Y.Z`  raise the extension version everywhere
# `just link`    symlink the binary into Zed and VS Code
# `just unlink`  remove those dev symlinks
# `just status`  show the current link state

# Print available recipes.
default:
    @just --list

# ------------------------------------------------------------------------------
# release
# ------------------------------------------------------------------------------

# Bump the extension version in every file that pins it:
#   vscode/package.json, zed/extension.toml, zed/Cargo.toml,
#   zed/Cargo.lock and zed/src/lib.rs.
# Usage: just bump-version 0.0.4
# Afterward: commit, push, then run the "Release" action on GitHub. The action
# reads this version, creates the v<version> tag and publishes the release.
bump-version version:
    #!/usr/bin/env sh
    set -eu
    new_version="{{version}}"
    echo "$new_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
        echo "bump-version: '$new_version' is not a X.Y.Z version" >&2
        exit 1
    }
    perl -pi -e 's/^  "version": ".*",$/  "version": "{{version}}",/' vscode/package.json
    perl -pi -e 's/^version = ".*"$/version = "{{version}}"/' zed/extension.toml
    perl -pi -e 's/^version = ".*"$/version = "{{version}}"/' zed/Cargo.toml
    perl -0pi -e 's/(\[\[package\]\]\nname = "gren-zed-extension-unofficial"\nversion = ")[^"]*(")/${1}{{version}}$2/' zed/Cargo.lock
    perl -pi -e 's/^const VERSION: &str = ".*";$/const VERSION: \&str = "{{version}}";/' zed/src/lib.rs
    echo "bumped to $new_version:"
    grep '"version":' vscode/package.json
    grep '^version = ' zed/extension.toml zed/Cargo.toml
    grep '^const VERSION' zed/src/lib.rs
    echo "next: commit, push, then run the \"Release\" action on GitHub"

# ------------------------------------------------------------------------------
# configuration
# ------------------------------------------------------------------------------

# Locally built language-server binary that the editor symlinks point at.
# Built with `just build`. For fast dev rebuilds, build debug and point this at
# target/debug/gren-language-server-unofficial instead.
BINARY := justfile_directory() + "/target/release/gren-language-server-unofficial"

# Language-server binary name (must match the editors' expected name).
BIN_NAME := "gren-language-server-unofficial"

# macOS Zed extension work directory (matches extension id "gren_unofficial").
# Zed runs the extension with this as its CWD, so both `download_file` and the
# dev symlink must live here.
ZED_DIR := env_var("HOME") + "/Library/Application Support/Zed/extensions/work/gren_unofficial"

# macOS VS Code globalStorage directory. "undefined_publisher" is literal:
# vscode/package.json declares no `publisher` field, so VS Code uses this as the
# storage prefix.
VSCODE_DIR := env_var("HOME") + "/Library/Application Support/Code/User/globalStorage/undefined_publisher.gren-language-server-unofficial"

# ------------------------------------------------------------------------------
# build
# ------------------------------------------------------------------------------

# Build the language server (optimized release binary).
build:
    cargo build --release

# ------------------------------------------------------------------------------
# tests
# ------------------------------------------------------------------------------

# Run the formatter regression tests (builds the debug binary first).
# node >= 23.6 runs typescript files natively.
test:
    cargo build
    node tests/format/runFormatTests.ts

# Regenerate formatter test snapshots after an intentional formatter change.
# Review the diff in tests/format/expected afterwards.
test-update:
    cargo build
    node tests/format/runFormatTests.ts --update

# ------------------------------------------------------------------------------
# symlinks
# ------------------------------------------------------------------------------

# Link the binary into both Zed and VS Code.
link: link-zed link-vscode

# Remove the dev symlinks from both editors.
unlink: unlink-zed unlink-vscode

# Link the built binary into Zed's dev extension work directory.
link-zed:
    #!/usr/bin/env sh
    set -eu
    target="{{ZED_DIR}}/{{BIN_NAME}}"
    if [ -d "$target" ] && [ ! -L "$target" ]; then
        echo "zed: refusing to link — '$target' is an existing directory." >&2
        echo "     remove it manually if that is intended, then re-run." >&2
        exit 1
    fi
    mkdir -p "{{ZED_DIR}}"
    rm -f "$target"
    ln -s "{{BINARY}}" "$target"
    echo "zed:    $target -> {{BINARY}}"

# Link the built binary into VS Code's globalStorage. Also writes the `version`
# file VS Code requires (extension.ts checks it) to use the binary instead of
# re-downloading and clobbering the symlink. The version written is the
# INSTALLED extension's version: if it differs from vscode/package.json,
# the extension would otherwise re-download its release over the symlink.
link-vscode:
    #!/usr/bin/env sh
    set -eu
    target="{{VSCODE_DIR}}/{{BIN_NAME}}"
    if [ -d "$target" ] && [ ! -L "$target" ]; then
        echo "vscode: refusing to link — '$target' is an existing directory." >&2
        echo "        remove it manually if that is intended, then re-run." >&2
        exit 1
    fi
    mkdir -p "{{VSCODE_DIR}}"
    rm -f "$target"
    ln -s "{{BINARY}}" "$target"
    installed_ext_dir=$(ls -d "$HOME"/.vscode/extensions/*gren-language-server-unofficial-* 2>/dev/null | tail -1 || true)
    installed_version=${installed_ext_dir##*-}
    if [ -z "$installed_version" ]; then
        installed_version=$(jq -r .version "{{justfile_directory()}}/vscode/package.json")
        echo "vscode: installed extension not found, falling back to package.json version" >&2
    fi
    echo "$installed_version" > "{{VSCODE_DIR}}/version"
    echo "vscode: $target -> {{BINARY}} (cache key: installed extension version $installed_version)"

# Remove the Zed dev symlink (leaves a real directory in place).
unlink-zed:
    #!/usr/bin/env sh
    target="{{ZED_DIR}}/{{BIN_NAME}}"
    if [ -L "$target" ]; then
        rm "$target"
        echo "removed $target"
    elif [ -d "$target" ]; then
        echo "zed: '$target' is a directory, not a symlink; leaving it in place." >&2
    else
        echo "zed: nothing to unlink at $target"
    fi

# Remove the VS Code dev symlink and its version file.
unlink-vscode:
    #!/usr/bin/env sh
    target="{{VSCODE_DIR}}/{{BIN_NAME}}"
    if [ -L "$target" ]; then
        rm "$target"
        rm -f "{{VSCODE_DIR}}/version"
        echo "removed $target"
    elif [ -d "$target" ]; then
        echo "vscode: '$target' is a directory, not a symlink; leaving it in place." >&2
    else
        echo "vscode: nothing to unlink at $target"
    fi

# Show the current link state for each editor.
status:
    #!/usr/bin/env sh
    for pair in "zed|{{ZED_DIR}}/{{BIN_NAME}}" "vscode|{{VSCODE_DIR}}/{{BIN_NAME}}"; do
        target=${pair#*|}
        name=${pair%|*}
        if [ -L "$target" ]; then
            echo "$name: -> $(readlink "$target")"
        elif [ -d "$target" ]; then
            echo "$name: directory present at '$target' (remove it before linking)"
        elif [ -e "$target" ]; then
            echo "$name: file present (not a symlink) at '$target'"
        else
            echo "$name: not linked"
        fi
    done
