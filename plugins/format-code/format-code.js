#!/usr/bin/env node
/**
 * Format Code - PostToolUse Hook for Write|Edit
 * Auto-formats files after Claude Code modifies them.
 * Supports Python (ruff) and Markdown/YAML/JSON (prettier).
 * Logs to: ~/.claude/hooks-logs/
 *
 * Install as a plugin (recommended): /plugin install format-code@claude-code-hooks
 * The plugin registers the PostToolUse hook automatically; updates arrive via
 * the marketplace instead of hand-edited copies.
 *
 * Classic setup in .claude/settings.json still works (copy this file anywhere):
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Write|Edit",
 *       "hooks": [{ "type": "command", "command": "node /path/to/format-code.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');

const PRETTIER_EXTS = new Set(['.js', '.ts', '.json', '.md', '.yaml', '.yml', '.html']);

// Extensions oxfmt is expected to handle in an oxfmt project. Other extensions
// (for example .html) still go through prettier.
const OXFMT_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc', '.md', '.mdx', '.css', '.yaml', '.yml']);

const OXFMT_CONFIG_FILES = ['.oxfmtrc.json', '.oxfmtrc.jsonc', '.oxfmtrc', 'oxfmt.config.ts', 'oxfmt.config.js', 'oxfmt.config.mjs', 'oxfmt.config.cjs'];

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

const FORMATTERS = {
  '.py': (fp) => [
    ['uv', 'run', 'ruff', 'check', '--fix', '--exit-zero', '--quiet', fp],
    ['uv', 'run', 'ruff', 'format', '--quiet', fp],
  ],
};

for (const ext of PRETTIER_EXTS) {
  FORMATTERS[ext] = (fp) => [['npx', '--yes', 'prettier', '--write', fp]];
}

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'format-code', ...data }) + '\n');
  } catch {}
}

function getFormatter(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FORMATTERS[ext] || null;
}

/** Walk up from a directory until a package.json (the project root) is found. */
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Pick the formatter the project itself uses. A project that declares oxfmt
 * gets oxfmt; one that declares prettier (dependency or config file) gets
 * prettier; anything else falls back to prettier for backwards compatibility.
 */
function detectProjectFormatter(root) {
  if (!root) return null;
  const pkg = readPackageJson(root);
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const hasOxfmt = OXFMT_CONFIG_FILES.some((f) => fs.existsSync(path.join(root, f))) || Boolean(pkg?.oxfmt) || Boolean(deps.oxfmt);
  if (hasOxfmt) return 'oxfmt';
  const hasPrettier = PRETTIER_CONFIG_FILES.some((f) => fs.existsSync(path.join(root, f))) || Boolean(pkg?.prettier) || Boolean(deps.prettier);
  if (hasPrettier) return 'prettier';
  return null;
}

/** Prefer the project's own binary so its pinned version is used. */
function resolveBinary(root, name) {
  if (!root) return null;
  const bin = path.join(root, 'node_modules', '.bin', name);
  return fs.existsSync(bin) ? bin : null;
}

function run(argv, cwd) {
  try {
    return spawnSync(argv[0], argv.slice(1), { cwd, stdio: 'pipe' });
  } catch (e) {
    return { status: -1, stderr: Buffer.from(e.message) };
  }
}

function formatFile(filePath, cwd, sessionId) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  if (!fs.existsSync(absPath)) {
    log({ level: 'SKIP', reason: 'file not found', file: absPath, session_id: sessionId });
    return { success: false, error: 'file not found' };
  }

  const ext = path.extname(absPath).toLowerCase();
  const getCommands = FORMATTERS[ext];
  if (!getCommands) {
    log({ level: 'SKIP', reason: 'unsupported file type', file: absPath, session_id: sessionId });
    return { success: false, error: 'unsupported file type' };
  }

  const dir = path.dirname(absPath);
  const projectRoot = findProjectRoot(dir);
  const projectFormatter = detectProjectFormatter(projectRoot);

  // oxfmt projects: let oxfmt apply the project's own style (.oxfmtrc).
  // prettier defaults would otherwise rewrite quotes, semicolons and wrapping.
  if (projectFormatter === 'oxfmt' && OXFMT_EXTS.has(ext)) {
    const bin = resolveBinary(projectRoot, 'oxfmt');
    const result = run(bin ? [bin, absPath] : ['npx', '--yes', 'oxfmt', absPath], dir);
    if (result.status === 0) {
      log({ level: 'FORMATTED', formatter: 'oxfmt', file: absPath, session_id: sessionId });
      return { success: true, formatter: 'oxfmt' };
    }
    // No prettier fallback: an oxfmt project must never be reformatted with
    // prettier defaults. Files oxfmt cannot handle (for example .html) simply
    // stay untouched.
    const msg = result.stderr?.toString().trim() || `Process exited with code ${result.status}`;
    log({ level: 'SKIP', reason: 'oxfmt failed', formatter: 'oxfmt', file: absPath, error: msg, session_id: sessionId });
    return { success: false, error: msg, formatter: 'oxfmt' };
  }

  const formatterName = ext === '.py' ? 'ruff' : 'prettier';
  const prettierBin = ext === '.py' ? null : resolveBinary(projectRoot, 'prettier');

  for (const args of getCommands(absPath)) {
    // Swap `npx --yes prettier` for the project's pinned prettier when present.
    const argv = prettierBin && args[0] === 'npx' ? [prettierBin, ...args.slice(3)] : args;
    const result = run(argv, dir);
    if (result.status !== 0) {
      const msg = result.stderr?.toString().trim() || `Process exited with code ${result.status}`;
      log({ level: 'ERROR', formatter: formatterName, file: absPath, error: msg, session_id: sessionId });
      return { success: false, error: msg, formatter: formatterName };
    }
  }

  log({ level: 'FORMATTED', formatter: formatterName, file: absPath, session_id: sessionId });
  return { success: true, formatter: formatterName };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    return console.log('{}');
  }
  if (data === null || typeof data !== 'object') data = {};

  const { tool_name, tool_input, session_id, cwd } = data;

  if (!['Write', 'Edit'].includes(tool_name) || !tool_input?.file_path) {
    return console.log('{}');
  }

  formatFile(tool_input.file_path, cwd || process.cwd(), session_id);
  console.log('{}');
}

if (require.main === module) {
  main();
} else {
  module.exports = { getFormatter, formatFile, log, FORMATTERS, detectProjectFormatter, findProjectRoot };
}
