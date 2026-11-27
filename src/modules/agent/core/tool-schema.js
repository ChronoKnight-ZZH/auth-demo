'use strict';
/**
 * 最小 JSON Schema 校验器（仅覆盖工具参数需要的子集）。
 *
 * 支持：object / array / string / integer / number / boolean，
 * properties、required、additionalProperties:false、enum、min/maxLength、
 * min/maximum、maxItems。返回值只保留 schema 中声明的字段，避免模型塞入
 * 未知参数后被后续执行器误用。
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNode(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return value;

  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} 必须是对象`);
        return undefined;
      }
      const props = schema.properties || {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${path}.${key} 必填`);
        }
      }
      const out = {};
      for (const [key, subSchema] of Object.entries(props)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const parsed = validateNode(subSchema, value[key], `${path}.${key}`, errors);
        if (parsed !== undefined) out[key] = parsed;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) {
            errors.push(`${path}.${key} 不允许`);
          }
        }
      }
      return out;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} 必须是数组`);
        return undefined;
      }
      if (schema.maxItems != null && value.length > schema.maxItems) {
        errors.push(`${path} 最多 ${schema.maxItems} 项`);
      }
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        const parsed = validateNode(schema.items, value[i], `${path}[${i}]`, errors);
        if (parsed !== undefined) out.push(parsed);
      }
      return out;
    }

    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} 必须是字符串`);
        return undefined;
      }
      if (schema.minLength != null && value.length < schema.minLength) {
        errors.push(`${path} 长度不得小于 ${schema.minLength}`);
      }
      if (schema.maxLength != null && value.length > schema.maxLength) {
        errors.push(`${path} 长度不得超过 ${schema.maxLength}`);
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
      }
      return value;
    }

    case 'integer': {
      if (!Number.isInteger(value)) {
        errors.push(`${path} 必须是整数`);
        return undefined;
      }
      if (schema.minimum != null && value < schema.minimum) {
        errors.push(`${path} 不得小于 ${schema.minimum}`);
      }
      if (schema.maximum != null && value > schema.maximum) {
        errors.push(`${path} 不得大于 ${schema.maximum}`);
      }
      return value;
    }

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} 必须是数字`);
        return undefined;
      }
      if (schema.minimum != null && value < schema.minimum) {
        errors.push(`${path} 不得小于 ${schema.minimum}`);
      }
      if (schema.maximum != null && value > schema.maximum) {
        errors.push(`${path} 不得大于 ${schema.maximum}`);
      }
      return value;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${path} 必须是布尔值`);
        return undefined;
      }
      return value;
    }

    default:
      errors.push(`${path} 使用了不支持的 schema 类型`);
      return undefined;
  }
}

function validateToolInput(schema, value) {
  const errors = [];
  const parsed = validateNode(schema, value, 'input', errors);
  return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors };
}

module.exports = { validateToolInput };
