import { homedir } from "node:os"
import { join } from "node:path"

export type Env = NodeJS.ProcessEnv

// Read for installs made before the rename from opencode-ntfy-bridge.
export const legacy = (env: Env, key: string) =>
  env[`OPENCODE_OOB_BRIDGE_${key}`] || env[`OPENCODE_NTFY_BRIDGE_${key}`]

export const configDir = (env: Env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")

export function configPath(env: Env = process.env): string {
  return legacy(env, "CONFIG") || join(configDir(env), "oob-bridge.jsonc")
}

/** Read when the default config file is missing. */
export function legacyConfigPath(env: Env = process.env): string {
  return join(configDir(env), "ntfy-bridge.jsonc")
}

export function dataDir(env: Env = process.env): string {
  if (legacy(env, "DATA")) return legacy(env, "DATA")!
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "oob-bridge")
}

export function logPath(env: Env = process.env): string {
  return legacy(env, "LOG") || join(dataDir(env), "bridge.log")
}
