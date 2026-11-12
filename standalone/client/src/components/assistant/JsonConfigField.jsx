import { useEffect, useState } from 'react';
export function JsonConfigField({ label, value, onChange, testId, rows = 6 }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState('');
  useEffect(()=>{if(!error)setText(JSON.stringify(value ?? null,null,2));},[value]);
  return <label className="ai-json-field">{label}<textarea data-testid={testId} rows={rows} spellCheck={false} value={text} onChange={event => { setText(event.target.value); try { const parsed = JSON.parse(event.target.value); onChange(parsed); setError(''); } catch { setError('Complete the JSON before saving.'); } }} />{error && <span role="alert" data-config-invalid="true">{error}</span>}</label>;
}
