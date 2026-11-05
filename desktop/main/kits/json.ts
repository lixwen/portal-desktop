/** Managed control calls reject shadowed keys before any JSON object can erase
 * their ambiguity. Native/model payloads are bounded and nesting is limited. */
export function parseUniqueJson(text: string, maxBytes = 256 * 1024): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new Error('invalid_managed_json');
  let i = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[i] || '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') i++;
      else if (char === '"') { try { return JSON.parse(text.slice(start, i)) as string; } catch { break; } }
    }
    throw new Error('invalid_managed_json');
  };
  const value = (depth: number): unknown => {
    if (depth > 32) throw new Error('invalid_managed_json');
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space(); const result: Record<string, unknown> = Object.create(null);
      if (text[i] === '}') { i++; return result; }
      for (;;) {
        space(); if (text[i] !== '"') throw new Error('invalid_managed_json');
        const key = string(); space();
        if (Object.hasOwn(result, key) || text[i++] !== ':') throw new Error('invalid_managed_json');
        result[key] = value(depth + 1); space();
        if (text[i] === '}') { i++; return result; }
        if (text[i++] !== ',') throw new Error('invalid_managed_json');
      }
    }
    if (text[i] === '[') {
      i++; space(); const result: unknown[] = [];
      if (text[i] === ']') { i++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space();
        if (text[i] === ']') { i++; return result; }
        if (text[i++] !== ',') throw new Error('invalid_managed_json');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) throw new Error('invalid_managed_json');
    i += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === 'number' && (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result)))) throw new Error('invalid_managed_json');
    return result;
  };
  const result = value(0); space(); if (i !== text.length) throw new Error('invalid_managed_json'); return result;
}
