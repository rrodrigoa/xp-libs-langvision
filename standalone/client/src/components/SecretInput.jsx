import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export function SecretInput({ label = "Connection string", value, onChange, testId, disabled = false, onReveal, ...inputProps }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const action = `${visible ? "Hide" : "Show"} ${label.toLowerCase()}`;
  const Icon = visible ? EyeOff : Eye;
  return <div className="secret-input-field" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setVisible(false);
  }}>
    <label htmlFor={id}>{label}</label>
    <div className="secret-input-control">
      <input {...inputProps} id={id} type={visible ? "text" : "password"} autoComplete="off" spellCheck={false}
        value={value} onChange={onChange} disabled={disabled} data-testid={testId} />
      <button type="button" aria-label={action} title={action} aria-controls={id} aria-pressed={visible}
        data-testid={testId ? `${testId}-visibility` : undefined}
        disabled={disabled} onClick={async () => { if (!visible && !value && onReveal) { if (await onReveal() === false) return; } setVisible(current => !current); }}><Icon size={17} aria-hidden="true" /></button>
    </div>
  </div>;
}
