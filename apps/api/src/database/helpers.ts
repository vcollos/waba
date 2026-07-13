import { createHash, randomUUID } from 'node:crypto';
import { ContactRecord, ParameterSource, TemplateVariableDescriptor } from './types';

export const nowIso = (): string => new Date().toISOString();

export const newId = (): string => randomUUID();

export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const normalizePhone = (value: string): { phoneE164: string; error?: string } => {
  const digits = value.replace(/\D+/g, '').replace(/^0+/, '');
  const normalizedDigits =
    digits.length === 10 || digits.length === 11
      ? `55${digits}`
      : digits;

  if (normalizedDigits.length < 12 || normalizedDigits.length > 15) {
    return { phoneE164: normalizedDigits, error: 'Telefone inválido para E.164' };
  }

  return { phoneE164: `+${normalizedDigits}` };
};

export const normalizeKeyword = (value: string): string =>
  value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

export const resolveParameterValue = (
  source: ParameterSource | undefined,
  contact: ContactRecord,
): string => {
  if (!source) {
    return '';
  }

  switch (source.type) {
    case 'static':
      return source.value;
    case 'contact_name':
      return contact.name;
    case 'contact_phone':
      return contact.phoneE164;
    case 'contact_email':
      return contact.email ?? '';
    case 'contact_attribute':
      return contact.attributes[source.key] ?? '';
  }
};

// Detecta variáveis posicionais ({{1}}) e nomeadas ({{link}}, {{customer_name}}).
const PLACEHOLDER_RE = /{{\s*([\w.-]+)\s*}}/g;

export const extractVariableDescriptors = (
  components: unknown[],
): TemplateVariableDescriptor[] => {
  const descriptors: TemplateVariableDescriptor[] = [];

  for (const component of components as Array<Record<string, unknown>>) {
    const type = String(component.type ?? '').toLowerCase();
    if (type !== 'body' && type !== 'header') {
      continue;
    }
    const text = typeof component.text === 'string' ? component.text : '';
    const seen = new Set<string>();
    let ordinal = 0;

    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const token = match[1];
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      ordinal += 1;
      const positional = /^\d+$/.test(token);
      descriptors.push({
        componentType: type as 'body' | 'header',
        placeholderIndex: positional ? Number(token) : ordinal,
        paramName: positional ? null : token,
        label: `${type.toUpperCase()} {{${token}}}`,
      });
    }
  }

  return descriptors;
};
