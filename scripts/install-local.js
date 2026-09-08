#!/usr/bin/env node
/*
 * Build, package, and (re)install CodeVisualizer into your local VS Code globally.
 *
 * One command to go from source -> installed extension:
 *   1. Builds the production webpack bundle (npm run package).
 *   2. Packages a .vsix with @vscode/vsce (via npx, no global install needed).
 *   3. Installs/updates it into VS Code with `code --install-extension --force`.
 *
 * After it finishes, the extension is available in EVERY VS Code window.
 * Reload the window (Ctrl+Shift+P -> "Developer: Reload Window") or restart
 * VS Code to pick up the new build.
 *
 * Usage:
 *   node scripts/install-local.js [options]
 *   npm run install:local -- [options]
 *
 * Options:
 *   --code <cmd>   VS Code CLI to install into (default: "code"; use "code-insiders").
 *   --skip-build   Repackage + reinstall the current dist/ without rebuilding.
 *   --keep-vsix    Keep the generated .vsix (default: removed after install).
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

// --- arg parsing -------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const codeCli = opt("--code", "code");
const skipBuild = flag("--skip-build");
const keepVsix = flag("--keep-vsix");

// --- helpers -----------------------------------------------------------------
const colors = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

function run(parts) {
  // Pass the full command line as a single string with shell:true so Windows
  // resolves npm/npx/code (.cmd shims) just like a terminal. Building one string
  // (rather than an args array) avoids Node's DEP0190 shell-args warning.
  const line = parts.join(" ");
  const res = spawnSync(line, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (exit ${res.status}): ${line}`);
  }
}

// Quote a path/arg for safe inclusion in a shell command line.
function q(s) {
  return `"${s}"`;
}

function which(cmd) {
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(`${probe} ${cmd}`, { shell: true }).status === 0;
}

function windowsCodeCliCandidates(cmd) {
  const suffix = cmd === "code-insiders" ? "Insiders\\bin\\code-insiders.cmd" : "bin\\code.cmd";
  return [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", `Microsoft VS Code${cmd === "code-insiders" ? " Insiders" : ""}`, "bin", cmd === "code-insiders" ? "code-insiders.cmd" : "code.cmd"),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, "Microsoft VS Code", suffix),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(process.env["PROGRAMFILES(X86)"], "Microsoft VS Code", suffix),
  ].filter(Boolean);
}

function resolveCodeCli(cmd) {
  if (which(cmd)) {
    return cmd;
  }

  if (process.platform !== "win32" || (cmd !== "code" && cmd !== "code-insiders")) {
    return null;
  }

  const found = windowsCodeCliCandidates(cmd).find((candidate) => fs.existsSync(candidate));
  return found ? q(found) : null;
}

// Return the installed version of an extension id (e.g. "publisher.name"), or
// null if it is not installed. Uses `code --list-extensions --show-versions`,
// whose lines look like "publisher.name@1.2.3".
function installedVersion(cli, extId) {
  const res = spawnSync(`${cli} --list-extensions --show-versions`, {
    shell: true,
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout) {
    return null;
  }
  const prefix = `${extId}@`;
  const line = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

// --- main --------------------------------------------------------------------
function main() {
  console.log(colors.cyan(`==> Repo: ${repoRoot}`));

  if (!which("npm")) {
    throw new Error("npm not found on PATH. Install Node.js first.");
  }
  const resolvedCodeCli = resolveCodeCli(codeCli);
  if (!resolvedCodeCli) {
    throw new Error(
      `VS Code CLI '${codeCli}' not found on PATH. In VS Code run ` +
        `Ctrl+Shift+P -> "Shell Command: Install 'code' command in PATH", then retry.`
    );
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const vsixName = `${pkg.name}-${pkg.version}.vsix`;
  const vsixPath = path.join(repoRoot, vsixName);
  const extId = `${pkg.publisher}.${pkg.name}`;
  console.log(colors.cyan(`==> Extension: ${extId}@${pkg.version}`));

  // 0. Refuse to reinstall over an identical version. VS Code only picks up a
  // new build when the version changes, so installing the same version again is
  // almost always a mistake (the editor keeps running the old bits). If a
  // different version is already installed, remember it so we can uninstall it
  // first and replace it cleanly.
  const existingVersion = installedVersion(resolvedCodeCli, extId);
  if (existingVersion === pkg.version) {
    throw new Error(
      `'${extId}' ${pkg.version} is already installed. Bump the "version" in ` +
        `package.json before reinstalling, otherwise VS Code will keep running ` +
        `the old build.`
    );
  }
  if (existingVersion) {
    console.log(
      colors.gray(`==> Found installed ${extId}@${existingVersion}; will replace it.`)
    );
  }

  // 1. Install deps if needed
  if (!fs.existsSync(path.join(repoRoot, "node_modules"))) {
    console.log(colors.yellow("==> node_modules missing; running npm install..."));
    run(["npm", "install"]);
  }

  // 2. Build
  if (!skipBuild) {
    console.log(colors.yellow("==> Building production bundle (npm run package)..."));
    run(["npm", "run", "package"]);
  } else {
    console.log(colors.gray("==> Skipping build (--skip-build)."));
  }

  // 3. Package the .vsix
  // node_modules is excluded via .vscodeignore and everything is bundled by
  // webpack into dist/, so package with --no-dependencies.
  console.log(colors.yellow("==> Packaging .vsix..."));
  run(["npx", "--yes", "@vscode/vsce", "package", "--no-dependencies", "--out", q(vsixPath)]);

  // 4. Uninstall the previously installed version (if any), then install.
  if (existingVersion) {
    console.log(colors.yellow(`==> Uninstalling ${extId}@${existingVersion}...`));
    run([resolvedCodeCli, "--uninstall-extension", extId]);
  }
  console.log(colors.yellow(`==> Installing into '${codeCli}'...`));
  run([resolvedCodeCli, "--install-extension", q(vsixPath), "--force"]);

  // 5. Cleanup
  if (!keepVsix) {
    fs.rmSync(vsixPath, { force: true });
    console.log(colors.gray(`==> Removed ${vsixName} (use --keep-vsix to keep it).`));
  } else {
    console.log(colors.gray(`==> Kept ${vsixPath}`));
  }

  console.log("");
  console.log(colors.green(`DONE. '${pkg.displayName}' ${pkg.version} installed globally.`));
  console.log(
    colors.green(
      "Reload VS Code (Ctrl+Shift+P -> 'Developer: Reload Window') to use the new build."
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`\x1b[31mERROR:\x1b[0m ${err.message}`);
  process.exit(1);
}
