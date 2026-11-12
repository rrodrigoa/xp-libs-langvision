import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false, ownProperties: true });
const compiled = new Map();
export function validateAgentSchema(schema, value, schemaOnly = false) {
  try {
    const key = JSON.stringify(schema);
    if (key.length > 16000) return ['Response schema exceeds 16000 characters.'];
    let validate = compiled.get(key);
    if (!validate) {
      validate = ajv.compile(schema); compiled.set(key, validate);
      if (compiled.size > 64) { const oldest = compiled.keys().next().value; ajv.removeSchema(compiled.get(oldest).schema); compiled.delete(oldest); }
    }
    if (schemaOnly || validate(value)) return [];
    return validate.errors.slice(0, 20).map(error => `${error.instancePath || 'response'} ${error.message}`);
  } catch (error) { return [`Invalid response schema: ${error.message}`]; }
}
