import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { createSkillSync, skillDirectories } from "./skills-sync.js";
import { findUpdate } from "./update.js";

const PREFERRED_PORT = 4312;
const PORT_ATTEMPTS = 20;
const PORT_PROBE_MS = 400;
const originFor = (port) => `http://127.0.0.1:${port}`;
const HEALTH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 6_000;
const STOP_TIMEOUT_MS = 5_000;
const HANDOFF_TIMEOUT_MS = 4_000;
const FADE_MS = 220;
const FADE_STEPS = 12;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 512;
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const SHELL_PATH_TIMEOUT_MS = 5_000;
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LOCAL_SERVER = Object.freeze({ id: "local", name: "Este computador", kind: "local" });
const HIDDEN_FLAG = "--hidden";
const UPDATE_FIRST_CHECK_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TRAY_ICON_SIZE = { win32: 16, linux: 22 };
const TRAY_PLACE = process.platform === "darwin" ? "na barra de menus" : "na bandeja do sistema";

const ERRORS = {
  invalidUrl: "Endereço inválido. Use algo como https://runelay.exemplo.com.",
  insecureUrl: "Use https. Endereço http só vale para localhost, 127.0.0.1 ou .ts.net.",
  unreachable: "Não achei um servidor runelay nesse endereço. Confira o endereço e se o servidor está no ar.",
  invalidRequest: "Pedido inválido.",
  invalidName: "O nome precisa ter de 1 a 60 caracteres.",
  duplicate: "Esse servidor já está na lista.",
  notFound: "Servidor não encontrado.",
  renameLocal: "O servidor deste computador não pode ser renomeado.",
  removeLocal: "O servidor deste computador não pode ser removido.",
  removeActive: "Troque para outro servidor antes de remover este.",
  startupFailed: "Não consegui mudar a inicialização com o sistema.",
  missingKey: "Este computador ainda não tem uma chave para este servidor.",
  invalidKey: "Essa chave não vale neste servidor.",
  cliFailed: "Não consegui conferir os agentes deste computador.",
};

let server = null;
let window = null;
let chooser = null;
let config = null;
let home = null;
let activeOrigin = null;
let failurePromptOpen = false;
let handoff = null;
let tray = null;
let pendingEntry = null;
let updateBusy = false;
let skillSync = null;
let skillStatus = null;
let localPort = PREFERRED_PORT;
let localOrigin = originFor(PREFERRED_PORT);

const SERVER = process.platform === "win32" ? "runelay-server.exe" : "runelay-server";

const CLI = process.platform === "win32" ? "runelay-cli.exe" : "runelay-cli";

const appFile = (...parts) => join(import.meta.dirname, ...parts);

const userHome = () => process.env.RUNELAY_HOME || app.getPath("home");

const devIcon = () => appFile("build", "icon.png");

const windowIcon = () => (app.isPackaged || process.platform === "darwin" ? undefined : devIcon());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const fade = async (target, from, to) => {
  if (!target || target.isDestroyed()) return;
  for (let step = 1; step <= FADE_STEPS; step += 1) {
    await wait(FADE_MS / FADE_STEPS);
    if (target.isDestroyed()) return;
    target.setOpacity(from + ((to - from) * step) / FADE_STEPS);
  }
};

const resource = (name) =>
  app.isPackaged ? join(process.resourcesPath, name) : join(import.meta.dirname, "resources", process.arch, name);

const webDist = () => (app.isPackaged ? join(process.resourcesPath, "web") : join(import.meta.dirname, "..", "apps", "web", "dist"));

const securePreferences = (preload) => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

const configPath = () => join(app.getPath("userData"), "config.json");

const prefsPath = () => join(app.getPath("userData"), "desktop-prefs.json");

const readPrefs = () => {
  try {
    const stored = JSON.parse(readFileSync(prefsPath(), "utf8"));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
};

const writePrefs = (patch) => {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2), { mode: 0o600 });
};

const launchArgs = () => (app.isPackaged ? [HIDDEN_FLAG] : [app.getAppPath(), HIDDEN_FLAG]);

const autostartPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(app.getPath("home"), ".config"), "autostart", "runelay.desktop");

const quoteExec = (value) =>
  `"${value
    .replace(/["`$\\]/g, (char) => `\\${char}`)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%")}"`;

const autostartEntry = () =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=runelay",
    `Exec=${[process.env.APPIMAGE ?? process.execPath, ...launchArgs()].map(quoteExec).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");

const readOpenAtLogin = () => {
  try {
    if (process.platform === "linux") return existsSync(autostartPath());
    return app.getLoginItemSettings({ args: launchArgs() }).openAtLogin;
  } catch {
    return false;
  }
};

const writeOpenAtLogin = (enabled) => {
  if (process.platform !== "linux") return app.setLoginItemSettings({ openAtLogin: enabled, args: launchArgs() });
  const file = autostartPath();
  if (!enabled) return rmSync(file, { force: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, autostartEntry(), { mode: 0o644 });
};

const refreshAutostart = () => {
  if (process.platform !== "linux") return;
  try {
    const file = autostartPath();
    if (existsSync(file) && readFileSync(file, "utf8") !== autostartEntry()) writeOpenAtLogin(true);
  } catch {}
};

const openedHidden = () =>
  process.argv.includes(HIDDEN_FLAG) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);

const parseServerUrl = (raw) => {
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: ERRORS.invalidUrl };
  }
  if (parsed.username || parsed.password) return { error: ERRORS.invalidUrl };
  const plainAllowed = PLAIN_HTTP_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".ts.net");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && plainAllowed)) return { error: ERRORS.insecureUrl };
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
};

const readName = (value) => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
};

const defaultName = (url) => new URL(url).hostname.slice(0, MAX_NAME_LENGTH);

const readId = (value) => (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null);

const readApiKey = (entry) => (typeof entry?.apiKey === "string" && entry.apiKey.length > 0 ? { apiKey: entry.apiKey } : {});

const readRemote = (entry) => {
  if (!entry || entry.kind !== "remote" || !readId(entry.id) || entry.id === LOCAL_SERVER.id) return null;
  if (typeof entry.url !== "string") return null;
  const parsed = parseServerUrl(entry.url);
  if (parsed.error) return null;
  return {
    id: entry.id,
    name: readName(entry.name) ?? defaultName(parsed.url),
    kind: "remote",
    url: parsed.url,
    ...readApiKey(entry),
  };
};

const buildConfig = (remotes, active, { local, syncSkills } = {}) => {
  const servers = [{ ...LOCAL_SERVER, ...readApiKey(local) }];
  for (const remote of remotes) {
    if (servers.some((entry) => entry.id === remote.id || entry.url === remote.url)) continue;
    servers.push(remote);
  }
  return {
    active: servers.some((entry) => entry.id === active) ? active : LOCAL_SERVER.id,
    servers,
    syncSkills: syncSkills !== false,
  };
};

const migrateConfig = (stored) => {
  const options = { syncSkills: stored?.syncSkills };
  if (stored?.mode === "local") return buildConfig([], LOCAL_SERVER.id, options);
  if (stored?.mode === "remote") {
    const remote = readRemote({ id: randomUUID(), kind: "remote", url: stored.url });
    return remote ? buildConfig([remote], remote.id, options) : null;
  }
  if (!Array.isArray(stored?.servers)) return null;
  const local = stored.servers.find((entry) => entry?.id === LOCAL_SERVER.id);
  return buildConfig(stored.servers.map(readRemote).filter(Boolean), stored.active, { ...options, local });
};

const writeConfig = (next) => {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
};

const readConfig = () => {
  let stored;
  try {
    stored = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
  const next = migrateConfig(stored);
  if (next && JSON.stringify(next) !== JSON.stringify(stored)) writeConfig(next);
  return next;
};

const saveConfig = (next) => {
  writeConfig(next);
  config = next;
  Menu.setApplicationMenu(buildMenu());
};

const activeServer = () => config.servers.find((entry) => entry.id === config.active) ?? LOCAL_SERVER;

const findServer = (id) => config.servers.find((entry) => entry.id === id) ?? null;

const findByUrl = (url) => config?.servers.find((entry) => entry.url === url) ?? null;

const isLocalActive = () => Boolean(config) && activeServer().kind === "local";

const logPath = () => join(app.getPath("userData"), "desktop.log");

const log = (line) => {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
};

const cliConfigPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(userHome(), ".config"), "runelay", "config.json");

const serverIdentity = (raw) => {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

const readCliKey = (url) => {
  try {
    const stored = JSON.parse(readFileSync(cliConfigPath(), "utf8"));
    if (typeof stored?.apiKey !== "string" || !stored.apiKey) return null;
    return serverIdentity(stored.url) === serverIdentity(url) ? stored.apiKey : null;
  } catch {
    return null;
  }
};

const skillConnection = () => {
  const active = activeServer();
  const url = active.kind === "local" ? localOrigin : active.url;
  const apiKey = active.apiKey ?? readCliKey(url);
  return apiKey ? { url, apiKey } : null;
};

const activeUrl = () => {
  const active = activeServer();
  return active.kind === "local" ? localOrigin : active.url;
};

const checkApiKey = async (url, apiKey) => {
  try {
    const response = await fetch(`${url}/v1/cli/status`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return "valid";
    return response.status === 401 || response.status === 403 ? "invalid" : "unreachable";
  } catch {
    return "unreachable";
  }
};

const agentConnection = async () => {
  const connection = skillConnection();
  if (!connection) return null;
  return (await checkApiKey(connection.url, connection.apiKey)) === "invalid" ? null : connection;
};

const storeApiKey = (apiKey) => {
  saveConfig({
    ...config,
    servers: config.servers.map((entry) => (entry.id === config.active ? { ...entry, apiKey } : entry)),
  });
  startSkillSync();
};

const cliBinary = () => resource(CLI);

const cliInvocation = () => {
  if (app.isPackaged || existsSync(cliBinary())) return { command: cliBinary(), args: [] };
  return { command: "bun", args: [join(import.meta.dirname, "..", "apps", "cli", "src", "index.ts")] };
};

const EXTRA_PATH_DIRS = [
  [".local", "bin"],
  [".bun", "bin"],
  [".claude", "local"],
  [".npm-global", "bin"],
  [".volta", "bin"],
  [".cargo", "bin"],
];

const SYSTEM_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const PATH_MARKER = "__RUNELAY_PATH__";

const loginShellPath = () =>
  new Promise((resolve) => {
    if (process.platform === "win32") return resolve("");
    execFile(
      process.env.SHELL || "/bin/sh",
      ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
      { timeout: SHELL_PATH_TIMEOUT_MS, encoding: "utf8" },
      (_error, stdout) => resolve(String(stdout ?? "").split(PATH_MARKER)[1] ?? ""),
    );
  });

let agentPathPromise = null;

const agentPath = () => {
  agentPathPromise ??= loginShellPath().then((shellPath) => {
    const home = userHome();
    const parts = [
      ...shellPath.split(delimiter),
      ...(process.env.PATH ?? "").split(delimiter),
      ...EXTRA_PATH_DIRS.map((segments) => join(home, ...segments)),
      ...(process.platform === "win32" ? [] : SYSTEM_PATH_DIRS),
    ];
    return [...new Set(parts.filter(Boolean))].join(delimiter);
  });
  return agentPathPromise;
};

const lastJsonLine = (output) => {
  const lines = output.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
};

const runCli = async (args, connection) => {
  const { command, args: prefix } = cliInvocation();
  const env = {
    ...process.env,
    PATH: await agentPath(),
    RUNELAY_URL: connection.url,
    RUNELAY_API_KEY: connection.apiKey,
    NO_COLOR: "1",
  };
  return new Promise((resolve) => {
    let stdout = "";
    let child;
    try {
      child = spawn(command, [...prefix, ...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ code: -1, report: null, error: error instanceof Error ? error.message : String(error) });
    }
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) log(`cli ${args[0]}: ${line}`);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, report: null, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const report = lastJsonLine(stdout);
      resolve({ code, report, error: report?.error?.message ?? null, errorCode: report?.error?.code ?? null });
    });
  });
};

let openablePaths = new Set();

const rememberPaths = (checks) => {
  openablePaths = new Set((checks ?? []).flatMap((check) => check.paths ?? []));
};

const runDoctorReport = async (connection) => {
  const { report, error, errorCode } = await runCli(["doctor"], connection);
  if (!report || report.command !== "doctor")
    return { error: error ?? ERRORS.cliFailed, errorCode: errorCode ?? null, agents: [], checks: [] };
  rememberPaths(report.checks);
  return { error: null, agents: report.agents, checks: report.checks };
};

let agentSetup = null;

const setupAgents = async (emit) => {
  const connection = await agentConnection();
  if (!connection) return { error: ERRORS.missingKey, code: "missing_key" };
  const step = (id, status, message = null) => emit({ type: "step", step: id, status, message });

  step("detect", "running");
  const detected = await runDoctorReport(connection);
  if (detected.error) {
    step("detect", "failed", detected.error);
    return { error: detected.error, code: "cli_failed", errorCode: detected.errorCode };
  }
  emit({ type: "agents", agents: detected.agents });
  step("detect", "done");

  step("migrate", "running");
  const migrated = await runCli(["migrate", "--yes"], connection);
  const migrate = migrated.report?.command === "migrate" ? migrated.report : null;
  step("migrate", migrate ? "done" : "failed", migrate ? null : migrated.error);

  step("connect", "running");
  const connected = await runCli(["connect"], connection);
  const connect = connected.report?.command === "connect" ? connected.report : null;
  if (connect) emit({ type: "agents", agents: connect.agents });
  step("connect", connect ? "done" : "failed", connect ? null : connected.error);

  step("pull", "running");
  const pulled = await runCli(["pull"], connection);
  step("pull", pulled.code === 0 ? "done" : "failed", pulled.code === 0 ? null : pulled.error);

  if (isLocalActive() && !readOpenAtLogin()) {
    try {
      writeOpenAtLogin(true);
    } catch {}
  }

  step("doctor", "running");
  const doctor = await runDoctorReport(connection);
  if (!doctor.error) emit({ type: "agents", agents: doctor.agents });
  step("doctor", doctor.error ? "failed" : "done", doctor.error);
  startSkillSync();

  return {
    error: null,
    code: null,
    agents: doctor.error ? (connect?.agents ?? detected.agents) : doctor.agents,
    checks: doctor.checks,
    imported: migrate?.imported ?? null,
    archived: migrate?.archived ?? null,
    pendingLogins: migrate?.pendingLogins ?? [],
    reconnectUrl: migrate?.reconnectUrl ?? null,
    failed: [migrate ? null : "migrate", connect ? null : "connect", pulled.code === 0 ? null : "pull"].filter(Boolean),
  };
};

const runsInBackground = () => Boolean(config) && Boolean(tray);

const isRunelayServer = async (base) => {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const health = await fetch(`${base}/health`, { signal })
    .then(async (response) => response.ok && (await response.text()).trim() === "ok")
    .catch(() => false);
  if (health) return true;
  return fetch(`${base}/v1/setup`, { signal })
    .then((response) => response.status === 401)
    .catch(() => false);
};

const resolveRemoteUrl = async (raw) => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { error: ERRORS.invalidRequest };
  const parsed = parseServerUrl(raw);
  if (parsed.error) return parsed;
  if (findByUrl(parsed.url)) return { error: ERRORS.duplicate };
  if (!(await isRunelayServer(parsed.url))) return { error: ERRORS.unreachable };
  return parsed;
};

const hasOnlyKeys = (input, allowed) =>
  Boolean(input) && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => allowed.includes(key));

const resolveChoice = async (input) => {
  if (!hasOnlyKeys(input, ["mode", "url"])) return { error: ERRORS.invalidRequest };
  if (input.mode === "local" && input.url === undefined) return { config: buildConfig([], LOCAL_SERVER.id) };
  if (input.mode !== "remote") return { error: ERRORS.invalidRequest };
  const result = await resolveRemoteUrl(input.url);
  if (result.error) return result;
  const remote = { id: randomUUID(), name: defaultName(result.url), kind: "remote", url: result.url };
  return { config: buildConfig([remote], remote.id) };
};

const isFromWindow = (event, target) =>
  Boolean(target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame && !event.senderFrame.parent);

const isFromMainWindow = (event) => {
  if (!config || !isFromWindow(event, window)) return false;
  try {
    return new URL(event.senderFrame.url).origin === activeOrigin;
  } catch {
    return false;
  }
};

const stopServer = () =>
  new Promise((resolve) => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill();
  });

const relaunch = async () => {
  await stopServer();
  app.relaunch();
  app.exit(0);
};

const activateServer = async (id) => {
  if (!config || id === config.active || !findServer(id)) {
    if (config) Menu.setApplicationMenu(buildMenu());
    return;
  }
  saveConfig({ ...config, active: id });
  await relaunch();
};

const serverMenu = () => ({
  label: "Servidor",
  submenu: config.servers.map((entry) => ({
    label: entry.name,
    type: "radio",
    checked: entry.id === config.active,
    click: () => activateServer(entry.id),
  })),
});

function buildMenu() {
  const servers = config ? [serverMenu(), { type: "separator" }] : [];
  const skills = config && !tray ? [...skillMenuItems(), { type: "separator" }] : [];
  if (process.platform === "darwin") {
    return Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { label: "Buscar atualizações…", click: () => checkForUpdate(true) },
          { type: "separator" },
          ...servers,
          ...skills,
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]);
  }
  return Menu.buildFromTemplate([
    {
      label: "Arquivo",
      submenu: [
        ...servers,
        { label: "Buscar atualizações…", click: () => checkForUpdate(true) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
}

const guard = (handler) => (event, ...args) => {
  if (!isFromMainWindow(event)) throw new Error("forbidden");
  return handler(...args);
};

const registerBridge = () => {
  ipcMain.handle(
    "runelay:list-servers",
    guard(() => ({
      active: config.active,
      servers: config.servers.map(({ id, name, kind, url }) => ({ id, name, kind, url: kind === "local" ? localOrigin : (url ?? null) })),
    })),
  );
  ipcMain.handle(
    "runelay:add-server",
    guard(async (input) => {
      if (!hasOnlyKeys(input, ["name", "url"])) return { error: ERRORS.invalidRequest, id: null };
      const name = input.name === undefined ? undefined : readName(input.name);
      if (name === null) return { error: ERRORS.invalidName, id: null };
      const result = await resolveRemoteUrl(input.url);
      if (result.error) return { error: result.error, id: null };
      if (findByUrl(result.url)) return { error: ERRORS.duplicate, id: null };
      const remote = { id: randomUUID(), name: name ?? defaultName(result.url), kind: "remote", url: result.url };
      saveConfig({ ...config, servers: [...config.servers, remote] });
      return { error: null, id: remote.id };
    }),
  );
  ipcMain.handle(
    "runelay:switch-server",
    guard(async (id) => {
      if (!readId(id) || !findServer(id)) return { error: ERRORS.notFound };
      await activateServer(id);
      return { error: null };
    }),
  );
  ipcMain.handle(
    "runelay:rename-server",
    guard((id, rawName) => {
      if (!readId(id) || !findServer(id)) return { error: ERRORS.notFound };
      if (id === LOCAL_SERVER.id) return { error: ERRORS.renameLocal };
      const name = readName(rawName);
      if (!name) return { error: ERRORS.invalidName };
      saveConfig({ ...config, servers: config.servers.map((entry) => (entry.id === id ? { ...entry, name } : entry)) });
      return { error: null };
    }),
  );
  ipcMain.handle(
    "runelay:remove-server",
    guard((id) => {
      if (!readId(id) || !findServer(id)) return { error: ERRORS.notFound };
      if (id === LOCAL_SERVER.id) return { error: ERRORS.removeLocal };
      if (id === config.active) return { error: ERRORS.removeActive };
      saveConfig({ ...config, servers: config.servers.filter((entry) => entry.id !== id) });
      return { error: null };
    }),
  );
  ipcMain.handle(
    "runelay:get-startup",
    guard(() => ({ supported: Boolean(config), local: isLocalActive(), openAtLogin: readOpenAtLogin() })),
  );
  ipcMain.handle(
    "runelay:agent-key-status",
    guard(async () => ({ ready: Boolean(await agentConnection()) })),
  );
  ipcMain.handle(
    "runelay:save-agent-key",
    guard(async (apiKey) => {
      if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > MAX_KEY_LENGTH) {
        return { error: ERRORS.invalidRequest };
      }
      const status = await checkApiKey(activeUrl(), apiKey);
      if (status !== "valid") return { error: status === "invalid" ? ERRORS.invalidKey : ERRORS.unreachable };
      storeApiKey(apiKey);
      return { error: null };
    }),
  );
  ipcMain.handle("runelay:setup-agents", async (event) => {
    if (!isFromMainWindow(event)) throw new Error("forbidden");
    const sender = event.sender;
    const emit = (payload) => {
      if (!sender.isDestroyed()) sender.send("runelay:setup-progress", payload);
    };
    agentSetup ??= setupAgents(emit).finally(() => {
      agentSetup = null;
    });
    return agentSetup;
  });
  ipcMain.handle(
    "runelay:doctor",
    guard(async () => {
      const connection = await agentConnection();
      if (!connection) return { error: ERRORS.missingKey, code: "missing_key", agents: [], checks: [] };
      return { ...(await runDoctorReport(connection)), code: null };
    }),
  );
  ipcMain.handle(
    "runelay:skills-sync-status",
    guard(() => skillSyncSnapshot()),
  );
  ipcMain.handle(
    "runelay:set-skills-sync",
    guard((enabled) => {
      if (typeof enabled !== "boolean") return { error: ERRORS.invalidRequest, ...skillSyncSnapshot() };
      setSkillSync(enabled);
      return { error: null, ...skillSyncSnapshot() };
    }),
  );
  ipcMain.handle(
    "runelay:open-path",
    guard(async (path) => {
      if (typeof path !== "string" || !openablePaths.has(path)) return { error: ERRORS.invalidRequest };
      const failure = await shell.openPath(path);
      return { error: failure || null };
    }),
  );
  ipcMain.handle(
    "runelay:set-startup",
    guard((enabled) => {
      if (typeof enabled !== "boolean") return { error: ERRORS.invalidRequest, openAtLogin: readOpenAtLogin() };
      try {
        writeOpenAtLogin(enabled);
      } catch {
        return { error: ERRORS.startupFailed, openAtLogin: readOpenAtLogin() };
      }
      syncRemoteTray();
      return { error: null, openAtLogin: readOpenAtLogin() };
    }),
  );
};

const chooseServer = () =>
  new Promise((resolve) => {
    let chosen = false;
    chooser = new BrowserWindow({
      width: 560,
      height: 640,
      center: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "runelay",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0d0e" : "#fdfdfd",
      show: false,
      icon: windowIcon(),
      webPreferences: securePreferences(appFile("chooser", "preload.cjs")),
    });
    chooser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    chooser.webContents.on("will-navigate", (event) => event.preventDefault());
    ipcMain.handle("chooser:choose", async (event, input) => {
      if (!isFromWindow(event, chooser)) throw new Error("forbidden");
      const result = await resolveChoice(input);
      if (result.error) return { error: result.error };
      if (chosen) return { error: ERRORS.invalidRequest };
      chosen = true;
      writeConfig(result.config);
      ipcMain.removeHandler("chooser:choose");
      handoff = { ready: deferred(), done: deferred() };
      resolve(result.config);
      await handoff.ready.promise;
      const active = activeServer();
      return { error: null, kind: active.kind, host: active.kind === "remote" ? new URL(active.url).host : null };
    });
    ipcMain.handle("chooser:done", (event) => {
      if (!isFromWindow(event, chooser)) throw new Error("forbidden");
      handoff?.done.resolve();
    });
    chooser.once("ready-to-show", () => chooser?.show());
    chooser.on("closed", () => {
      chooser = null;
      ipcMain.removeHandler("chooser:done");
      handoff?.ready.resolve();
      handoff?.done.resolve();
      if (!chosen) app.quit();
    });
    chooser.loadFile(appFile("chooser", "index.html"));
  });

const generateSecrets = () => ({
  secret: randomBytes(32).toString("hex"),
  setupToken: randomBytes(18).toString("hex"),
});

const loadSecrets = () => {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  const sealed = join(dir, "secrets.bin");
  const plain = join(dir, "secrets.json");
  const encrypt = safeStorage.isEncryptionAvailable();
  if (existsSync(sealed)) return JSON.parse(safeStorage.decryptString(readFileSync(sealed)));
  const secrets = existsSync(plain) ? JSON.parse(readFileSync(plain, "utf8")) : generateSecrets();
  if (!encrypt) {
    writeFileSync(plain, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
  writeFileSync(sealed, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
  rmSync(plain, { force: true });
  return secrets;
};

const portAnswers = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(PORT_PROBE_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const portBindable = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
  });

const portFree = async (port) => !(await portAnswers(port)) && (await portBindable(port));

const pickLocalPort = async () => {
  const remembered = Number(readPrefs().localPort);
  const range = Array.from({ length: PORT_ATTEMPTS }, (_, index) => PREFERRED_PORT + index);
  const candidates = [...new Set([...(Number.isInteger(remembered) && remembered > 0 ? [remembered] : []), ...range])];
  for (const port of candidates) if (await portFree(port)) return port;
  return null;
};

const discoveryPath = () => join(userHome(), ".runelay", "desktop.json");

const publishLocalUrl = () => {
  try {
    mkdirSync(dirname(discoveryPath()), { recursive: true });
    writeFileSync(discoveryPath(), JSON.stringify({ url: localOrigin, pid: process.pid }, null, 2), { mode: 0o600 });
  } catch (error) {
    log(`não consegui gravar ${discoveryPath()}: ${error instanceof Error ? error.message : error}`);
  }
};

const unpublishLocalUrl = () => {
  try {
    const stored = JSON.parse(readFileSync(discoveryPath(), "utf8"));
    if (stored?.pid === process.pid) rmSync(discoveryPath(), { force: true });
  } catch {}
};

const healthy = () =>
  fetch(`${localOrigin}/health`, { signal: AbortSignal.timeout(1000) })
    .then((response) => response.ok)
    .catch(() => false);

const waitForServer = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy()) return true;
    if (server?.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const startServer = (secrets) => {
  const userData = app.getPath("userData");
  const log = createWriteStream(join(userData, "server.log"), { flags: "a" });
  server = spawn(resource(SERVER), [], {
    env: {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PATH: process.env.PATH,
      RUNELAY_SECRET: secrets.secret,
      RUNELAY_SETUP_TOKEN: secrets.setupToken,
      RUNELAY_DATA: join(userData, "data"),
      RUNELAY_DESKTOP: "true",
      RUNELAY_ENABLE_STDIO: "true",
      WEB_DIST: webDist(),
      PUBLIC_URL: localOrigin,
      HOST: "127.0.0.1",
      PORT: String(localPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
};

const firstScreen = async (secrets) => {
  const setup = await fetch(`${localOrigin}/v1/setup`)
    .then((response) => response.json())
    .catch(() => null);
  return setup?.data?.needsSetup ? `${localOrigin}/login?mode=signup&token=${secrets.setupToken}` : localOrigin;
};

const isInternal = (url) => {
  if (url === "about:blank") return true;
  try {
    return new URL(url).origin === activeOrigin;
  } catch {
    return false;
  }
};

const promptRemoteFailure = async (_event, code, _description, failedUrl, isMainFrame) => {
  if (!isMainFrame || code === -3 || failurePromptOpen || !window) return;
  failurePromptOpen = true;
  dropHandoff();
  window.show();
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Tentar de novo", "Trocar servidor", "Sair"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: "Não consegui falar com o servidor",
    detail: `${activeServer().name} (${home}) não respondeu. Confira se o servidor está no ar ou volte para ${LOCAL_SERVER.name}.`,
  });
  failurePromptOpen = false;
  if (response === 0) return window?.loadURL(isInternal(failedUrl) ? failedUrl : home).catch(() => null);
  if (response === 1) return activateServer(LOCAL_SERVER.id);
  app.quit();
};

const createWindow = async (url) => {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "runelay",
    backgroundColor: "#0c0d0f",
    show: false,
    icon: windowIcon(),
    webPreferences: securePreferences(appFile("preload.cjs")),
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isInternal(target)) return { action: "allow", overrideBrowserWindowOptions: { width: 560, height: 720 } };
    shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (isInternal(target)) return;
    event.preventDefault();
    shell.openExternal(target);
  });
  window.once("ready-to-show", () => {
    if (handoff) return handoff.ready.resolve();
    window?.show();
    focusApp();
  });
  window.on("closed", () => {
    window = null;
  });
  if (activeServer().kind !== "remote") return window.loadURL(url);
  window.webContents.on("did-fail-load", promptRemoteFailure);
  await window.loadURL(url).catch(() => null);
};

const dropHandoff = () => {
  if (!handoff) return;
  handoff.ready.resolve();
  handoff = null;
  chooser?.destroy();
};

const completeHandoff = async () => {
  if (!handoff) return;
  const current = handoff;
  await current.ready.promise;
  await Promise.race([current.done.promise, wait(HANDOFF_TIMEOUT_MS)]);
  if (handoff !== current) return;
  handoff = null;
  if (window && !window.isDestroyed()) {
    window.setOpacity(0);
    window.show();
    focusApp();
  }
  await Promise.all([fade(chooser, 1, 0), fade(window, 0, 1)]);
  window?.setOpacity(1);
  chooser?.destroy();
};

const showWindow = async () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    focusApp();
    return;
  }
  if (!home) return;
  const entry = pendingEntry ?? home;
  pendingEntry = null;
  await createWindow(entry);
};

// macOS draws a template image in the menu bar's own colour, so the mark is
// as big as the other icons there and follows light and dark bars.
const trayIcon = () =>
  process.platform === "darwin"
    ? nativeImage.createFromPath(appFile("build", "trayTemplate.png"))
    : nativeImage.createFromPath(appFile("build", "icon.png")).resize({
        width: TRAY_ICON_SIZE[process.platform] ?? 22,
        height: TRAY_ICON_SIZE[process.platform] ?? 22,
      });

const formatTime = (date) => date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

const skillSyncState = () => {
  if (!config?.syncSkills) return "off";
  if (skillStatus?.missingKey) return "missing_key";
  if (skillStatus?.ok) return "synced";
  if (skillStatus) return "failed";
  return skillSync?.watching() ? "watching" : "no_folders";
};

const skillSyncSnapshot = () => ({
  enabled: Boolean(config?.syncSkills),
  state: skillSyncState(),
  label: skillStatusLabel(),
  at: skillStatus?.at instanceof Date ? skillStatus.at.toISOString() : null,
  count: skillStatus?.ok ? skillStatus.count : null,
  message: skillStatus && !skillStatus.ok && !skillStatus.missingKey ? (skillStatus.message ?? null) : null,
});

const skillMenuItems = () => [
  {
    label: "Sincronizar skills",
    type: "checkbox",
    checked: Boolean(config?.syncSkills),
    click: (item) => setSkillSync(item.checked),
  },
  { label: skillStatusLabel(), enabled: false },
];

const skillStatusLabel = () => {
  if (!config?.syncSkills) return "Sincronização de skills desligada";
  if (skillStatus?.missingKey) return "Skills: abra o runelay e use Conectar meus agentes";
  if (skillStatus?.ok) return `Skills sincronizadas às ${formatTime(skillStatus.at)}`;
  if (skillStatus) return `Falha ao sincronizar skills às ${formatTime(skillStatus.at)}`;
  return skillSync?.watching() ? "Skills: aguardando mudanças" : "Skills: nenhuma pasta encontrada";
};

// macOS only: while the menu bar icon exists, the app can leave the Dock and
// the app switcher (Cmd+Tab) and live in the menu bar alone.
const dockHidden = () => process.platform === "darwin" && Boolean(tray) && readPrefs().hideDock === true;

const applyDock = () => {
  if (process.platform !== "darwin" || !app.dock) return;
  if (dockHidden()) return app.dock.hide();
  app.dock.show().catch(() => {});
};

// Without a Dock icon the app is not activated when its window shows, so the
// window would open behind the app in front.
const focusApp = () => {
  if (dockHidden()) app.focus({ steal: true });
};

// Opening the app again from Finder or Spotlight while it runs puts it back in
// the Dock; take it out again and keep its window in front.
const keepOutOfDock = () => {
  if (!dockHidden() || !app.dock.isVisible()) return;
  app.dock.hide();
  focusApp();
};

const setDockVisible = (visible) => {
  const shown = Boolean(window) && !window.isDestroyed() && window.isVisible();
  writePrefs({ hideDock: !visible });
  applyDock();
  refreshTrayMenu();
  // Leaving the Dock deactivates the app; bring an open window back to the front.
  if (shown && !visible) {
    window.show();
    focusApp();
  }
};

const dockMenuItems = () =>
  process.platform === "darwin"
    ? [
        {
          label: "Mostrar no Dock",
          type: "checkbox",
          checked: !dockHidden(),
          click: (item) => setDockVisible(item.checked),
        },
        { type: "separator" },
      ]
    : [];

const trayMenu = () =>
  Menu.buildFromTemplate([
    { label: "Abrir runelay", click: () => showWindow() },
    { label: "Buscar atualizações…", click: () => checkForUpdate(true) },
    { type: "separator" },
    ...skillMenuItems(),
    { type: "separator" },
    ...dockMenuItems(),
    { label: "Sair", click: () => app.quit() },
  ]);

const refreshTrayMenu = () => {
  if (tray) return tray.setContextMenu(trayMenu());
  if (process.platform === "darwin" && config) Menu.setApplicationMenu(buildMenu());
};

const createTray = () => {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("runelay");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => showWindow());
  Menu.setApplicationMenu(buildMenu());
  applyDock();
};

const startSkillSync = () => {
  skillSync?.stop();
  skillSync = null;
  if (!config?.syncSkills) return refreshTrayMenu();
  const connection = skillConnection();
  if (!connection) {
    if (!skillStatus?.missingKey) log(`skills: sem chave de API para ${activeServer().name}; sincronização parada até Conectar meus agentes.`);
    skillStatus = { missingKey: true };
    return refreshTrayMenu();
  }
  if (skillStatus?.missingKey) skillStatus = null;
  skillSync = createSkillSync({
    directories: skillDirectories(userHome(), process.env.RUNELAY_SKILLS_DIR),
    connection,
    log,
    onStatus: (status) => {
      skillStatus = status;
      refreshTrayMenu();
    },
  });
  skillSync.start();
  refreshTrayMenu();
};

const setSkillSync = (enabled) => {
  saveConfig({ ...config, syncSkills: enabled });
  startSkillSync();
};

const syncRemoteTray = () => {
  if (isLocalActive()) return;
  if (readOpenAtLogin()) return createTray();
  tray?.destroy();
  tray = null;
  Menu.setApplicationMenu(buildMenu());
  applyDock();
};

const notifyBackground = () => {
  if (readPrefs().backgroundNoticeShown || !Notification.isSupported()) return;
  writePrefs({ backgroundNoticeShown: true });
  const body = isLocalActive()
    ? `O runelay continua rodando em segundo plano para os seus agentes. Para sair de vez, use Sair no ícone ${TRAY_PLACE}.`
    : `O runelay continua aberto no ícone ${TRAY_PLACE}. Para sair de vez, use Sair nesse ícone.`;
  new Notification({ title: "runelay", body }).show();
};

const messageBox = (options) =>
  window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

const downloadInstaller = async ({ fileName, url }) => {
  const target = join(app.getPath("downloads"), fileName);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download respondeu ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const progress = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (total && window && !window.isDestroyed()) window.setProgressBar(received / total);
      yield chunk;
    }
  };
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(target));
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    if (window && !window.isDestroyed()) window.setProgressBar(-1);
  }
  return target;
};

const openInstaller = async (file) => {
  if (process.platform === "linux") {
    chmodSync(file, 0o755);
    shell.showItemInFolder(file);
    await messageBox({
      type: "info",
      message: "A versão nova foi baixada",
      detail: `Feche o runelay e abra o arquivo novo:\n${file}`,
    });
    return;
  }
  const failure = await shell.openPath(file);
  if (failure) throw new Error(failure);
  if (process.platform === "win32") return app.quit();
  const { response } = await messageBox({
    type: "info",
    message: "O instalador abriu",
    detail: "Feche o runelay, arraste o runelay novo para Aplicativos e abra de novo.",
    buttons: ["Fechar o runelay", "Depois"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) app.quit();
};

const checkForUpdate = async (manual = false) => {
  if (updateBusy || (!manual && !app.isPackaged)) return;
  updateBusy = true;
  let downloading = false;
  try {
    const update = await findUpdate({ current: app.getVersion(), platform: process.platform, arch: process.arch });
    if (!update) {
      if (manual) await messageBox({ type: "info", message: `Você já está na versão mais recente (${app.getVersion()}).` });
      return;
    }
    if (!manual && readPrefs().skippedUpdate === update.version) return;
    const { response } = await messageBox({
      type: "info",
      message: `runelay ${update.version} disponível`,
      detail: `Você está na ${app.getVersion()}. O instalador vai para a pasta Downloads e abre em seguida.`,
      buttons: ["Baixar e instalar", "Agora não", "Pular esta versão"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 2) writePrefs({ skippedUpdate: update.version });
    if (response !== 0) return;
    downloading = true;
    if ((!window || window.isDestroyed()) && Notification.isSupported()) {
      new Notification({ title: `Baixando o runelay ${update.version}…`, body: "O instalador abre quando terminar." }).show();
    }
    await openInstaller(await downloadInstaller(update));
  } catch (error) {
    if (manual || downloading) dialog.showErrorBox("Não consegui atualizar", error instanceof Error ? error.message : String(error));
  } finally {
    updateBusy = false;
  }
};

const scheduleUpdateChecks = () => {
  setTimeout(() => checkForUpdate(), UPDATE_FIRST_CHECK_MS);
  setInterval(() => checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
};

const fail = (message) => {
  dialog.showErrorBox("runelay não abriu", message);
  app.quit();
};

const openRemote = async (hidden) => {
  home = activeServer().url;
  activeOrigin = new URL(home).origin;
  syncRemoteTray();
  startSkillSync();
  if (hidden && tray) return;
  await createWindow(home);
  await completeHandoff();
};

const openLocal = async (hidden) => {
  const port = await pickLocalPort();
  if (!port) {
    return fail(`As portas ${PREFERRED_PORT} a ${PREFERRED_PORT + PORT_ATTEMPTS - 1} estão ocupadas. Feche o que estiver usando uma delas e abra de novo.`);
  }
  if (port !== PREFERRED_PORT) log(`porta ${PREFERRED_PORT} ocupada; servidor local em ${port}`);
  localPort = port;
  localOrigin = originFor(port);
  let secrets;
  try {
    secrets = loadSecrets();
  } catch {
    return fail("Não consegui ler a chave do runelay no cofre do sistema (Keychain). Abra de novo e permita o acesso quando o sistema pedir.");
  }
  startServer(secrets);
  if (!(await waitForServer())) {
    return fail(`O servidor não subiu. Veja o log em ${join(app.getPath("userData"), "server.log")}.`);
  }
  writePrefs({ localPort });
  publishLocalUrl();
  home = localOrigin;
  activeOrigin = localOrigin;
  createTray();
  startSkillSync();
  const entry = await firstScreen(secrets);
  if (hidden) {
    pendingEntry = entry;
    return;
  }
  await createWindow(entry);
  await completeHandoff();
};

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (!window && !chooser && runsInBackground()) return showWindow();
  const target = window ?? (chooser?.isVisible() ? chooser : null);
  if (target?.isMinimized()) target.restore();
  target?.focus();
});

app.whenReady().then(async () => {
  if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(devIcon());
  Menu.setApplicationMenu(buildMenu());
  registerBridge();
  const stored = readConfig();
  config = stored ?? (await chooseServer());
  Menu.setApplicationMenu(buildMenu());
  scheduleUpdateChecks();
  if (app.isPackaged) refreshAutostart();
  const hidden = Boolean(stored) && openedHidden();
  if (activeServer().kind === "remote") return openRemote(hidden);
  return openLocal(hidden);
});

app.on("did-become-active", keepOutOfDock);

app.on("activate", async () => {
  keepOutOfDock();
  if (!window && home) await showWindow();
});

app.on("window-all-closed", () => {
  if (runsInBackground()) return notifyBackground();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  skillSync?.stop();
  unpublishLocalUrl();
  if (server) server.kill();
});
