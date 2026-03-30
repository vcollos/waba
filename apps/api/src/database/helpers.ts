import { createHash, randomUUID } from 'node:crypto';
import { ContactRecord, ParameterSource, TemplateVariableDescriptor } from './types';

export const nowIso = (): string => new Date().toISOString();

export const newId = (): string => randomUUID();

export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const normalizePhone = (value: string): { phoneE164: string; error?: string } => {
  const digits = value.replace(/\D+/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return { phoneE164: digits, error: 'Telefone inválido para E.164' };
  }

  return { phoneE164: `+${digits}` };
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

const countPlaceholders = (text: string): number => {
  const matches = Array.from(text.matchAll(/{{\s*(\d+)\s*}}/g));
  return matches.length;
};

export const extractVariableDescriptors = (
  components: unknown[],
): TemplateVariableDescriptor[] => {
  const descriptors: TemplateVariableDescriptor[] = [];

  for (const component of components as Array<Record<string, unknown>>) {
    const type = String(component.type ?? '').toLowerCase();
    const text = typeof component.text === 'string' ? component.text : '';
    const count = countPlaceholders(text);

    if ((type === 'body' || type === 'header') && count > 0) {
      for (let index = 1; index <= count; index += 1) {
        descriptors.push({
          componentType: type as 'body' | 'header',
          placeholderIndex: index,
          label: `${type.toUpperCase()} {{${index}}}`,
        });
      }
    }
  }

  return descriptors;
};
