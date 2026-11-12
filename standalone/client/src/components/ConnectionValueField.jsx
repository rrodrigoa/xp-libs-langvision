import { SecretInput } from "./SecretInput.jsx";
import { settingSource, changeSettingSource } from "../stores/connectionSettingValue.js";

export function ConnectionValueField({ config, name, label, testId, onChange, secret = false, disabled = false, onReveal }) {
  const mode = settingSource(config, name);
  return <div className="connection-value-field">
    <label>{label} value source<select aria-label={`${label} value source`} data-testid={`${testId}-source`} value={mode} disabled={disabled}
      onChange={event => onChange(changeSettingSource(name, event.target.value))}>
      <option value="value">Enter a value</option><option value="environment">Environment variable</option>
    </select></label>
    {mode === "environment" ? <label>{label} environment variable<input data-testid={`${testId}-environment`} autoComplete="off" spellCheck={false}
      value={config?.[`${name}EnvironmentVariable`] ?? ""} disabled={disabled} placeholder="CHRONUS_CONNECTION_SETTING"
      onChange={event => onChange({ [`${name}EnvironmentVariable`]: event.target.value })} />
      <small>Resolved by the Chronusphaera service at validation/run time. Enter the variable name, not its value.</small></label>
      : secret ? <SecretInput label={label} testId={testId} value={config?.[name] ?? ""} disabled={disabled} onReveal={onReveal} onChange={event => onChange({ [name]: event.target.value })} />
      : <label>{label}<input data-testid={testId} value={config?.[name] ?? ""} disabled={disabled} onChange={event => onChange({ [name]: event.target.value })} /></label>}
  </div>;
}
