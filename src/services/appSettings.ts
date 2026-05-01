import { invoke } from "@tauri-apps/api/core";

export type AppSettingsSnapshot = {
  apiKey: string | null;
  preferredModel: string | null;
};

export type AppSettingsPatch = {
  apiKey?: string;
  clearApiKey?: boolean;
  preferredModel?: string | null;
};

export async function appSettingsGet(): Promise<AppSettingsSnapshot> {
  const raw = await invoke<{ apiKey?: string | null; preferredModel?: string | null }>("app_settings_get");
  return {
    apiKey: raw.apiKey?.trim() ? raw.apiKey.trim() : null,
    preferredModel: raw.preferredModel?.trim() ? raw.preferredModel.trim() : null,
  };
}

export async function appSettingsSet(patch: AppSettingsPatch): Promise<void> {
  await invoke("app_settings_set", {
    patch: {
      apiKey: patch.apiKey,
      clearApiKey: patch.clearApiKey,
      preferredModel: patch.preferredModel ?? undefined,
    },
  });
}
