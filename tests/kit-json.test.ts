import { expect, it } from 'vitest';
import { parseUniqueJson } from '../desktop/main/kits/json';
it('rejects shadowed escaped keys, invalid values and excessive depth without changing valid business JSON', () => {
  const source = '{"name":"alias","arguments":{"title":"line\\nquote\\\"","items":[1,true,null,{"__proto__":"value"}]}}';
  expect(parseUniqueJson(source)).toEqual(JSON.parse(source));
  for (const invalid of ['{"name":"a","name":"b"}', '{"a":1,"\\u0061":2}', '{"arguments":{"x":1,"x":2}}', '{"x":1,}', '[1,]', '1e9999', '9007199254740993', '{"arguments":{"number":18446744073709551615}}', '["unfinished]', '{"a":NaN}', 'true false', '['.repeat(34) + ']'.repeat(34)]) expect(() => parseUniqueJson(invalid)).toThrow('invalid_managed_json');
});
