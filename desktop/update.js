const RELEASE_URL = "https://api.github.com/repos/runelay/runelay/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/runelay/runelay/releases/download/";
const RELEASE_TIMEOUT_MS = 10_000;

const ASSETS = {
  "darwin-arm64": "runelay-mac-arm64.dmg",
  "darwin-x64": "runelay-mac-x64.dmg",
  "win32-x64": "runelay-win-x64.exe",
  "linux-x64": "runelay-linux-x86_64.AppImage",
  "linux-arm64": "runelay-linux-arm64.AppImage",
};

export const parseVersion = (raw) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
};

export const isNewer = (candidate, current) => {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
};

export const installerName = (platform, arch) => ASSETS[`${platform}-${arch}`] ?? null;

export const findUpdate = async ({ current, platform, arch, fetchFn = fetch }) => {
  const fileName = installerName(platform, arch);
  if (!fileName) return null;
  const response = await fetchFn(RELEASE_URL, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub respondeu ${response.status}`);
  const release = await response.json();
  if (release?.draft || release?.prerelease || !isNewer(release?.tag_name, current)) return null;
  const asset = Array.isArray(release.assets) ? release.assets.find((entry) => entry?.name === fileName) : null;
  const url = asset?.browser_download_url;
  if (typeof url !== "string" || !url.startsWith(DOWNLOAD_PREFIX)) return null;
  return { version: parseVersion(release.tag_name).join("."), fileName, url };
};
