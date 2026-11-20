// Index UTF-8 ranges in the immutable serialized document, not reconstructed values.
export function indexJsonDocument(text,{utf8=true}={}) {
  const entries = []; let cursor = 0, byteCursor = 0, counted = 0;
  const bytes = () => { if(!utf8)return cursor;byteCursor += Buffer.byteLength(text.slice(counted, cursor)); counted = cursor; return byteCursor; };
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  function string() {
    const start = cursor++;
    while (cursor < text.length) { const char = text[cursor++]; if (char === '\\') cursor++; else if (char === '"') return text.slice(start, cursor); }
    throw new Error('Unterminated JSON string');
  }
  function value(path, parent, key, ordinal) {
    whitespace(); const start = bytes(), char = text[cursor];
    const type = char === '{' ? 'object' : char === '[' ? 'array' : char === '"' ? 'string' : text.startsWith('null', cursor) ? 'null' : /[tf]/.test(char) ? 'boolean' : 'number';
    const entry = { path, parent, key, ordinal, type, start, length: 0, count: 0 }; entries.push(entry);
    if (type === 'object' || type === 'array') {
      const closing = type === 'object' ? '}' : ']'; cursor++; whitespace();
      while (text[cursor] !== closing) {
        let childKey = String(entry.count);
        if (type === 'object') { childKey = JSON.parse(string()); whitespace(); if (text[cursor++] !== ':') throw new Error('Invalid JSON property'); }
        value(`${path}/${childKey.replace(/~/g, '~0').replace(/\//g, '~1')}`, path, childKey, entry.count++);
        whitespace(); if (text[cursor] !== ',') break; cursor++; whitespace();
      }
      if (text[cursor++] !== closing) throw new Error('Invalid JSON collection');
    } else if (type === 'string') string();
    else { while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++; }
    entry.length = bytes() - start;
  }
  value('', null, '', 0); whitespace();
  if (cursor !== text.length) throw new Error('Unexpected JSON content');
  return entries;
}

export function jsonCursorPath(entries,offset) {
  for(let index=entries.length-1;index>=0;index--)if(offset>=entries[index].start&&offset<entries[index].start+entries[index].length)return entries[index].path;
  return '';
}

export function jsonBreadcrumbs(path = '') {
  const parts = path ? path.slice(1).split('/') : [];
  return [{ path: '', label: '$' }, ...parts.map((part, index) => ({ path: '/' + parts.slice(0, index + 1).join('/'), label: part.replace(/~1/g, '/').replace(/~0/g, '~') }))];
}
