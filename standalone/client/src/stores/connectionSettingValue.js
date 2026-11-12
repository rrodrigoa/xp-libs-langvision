export function settingSource(config, key) {
  return config?.[`${key}Source`] ?? (config?.[`${key}EnvironmentVariable`] ? "environment" : "value");
}
export function hasConnectionValue(config, key) {
  return settingSource(config, key) === "environment"
    ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(config?.[`${key}EnvironmentVariable`] ?? "")
    : Boolean(String(config?.[key] ?? "").trim());
}
export function changeSettingSource(key, mode) {
  return { [`${key}Source`]: mode, [key]: "", [`${key}EnvironmentVariable`]: "" };
}
export function environmentSettings(config, keys) {
  return Object.fromEntries(keys.flatMap(key => [[`${key}Source`, settingSource(config, key)], [`${key}EnvironmentVariable`, config?.[`${key}EnvironmentVariable`] ?? ""]]));
}
