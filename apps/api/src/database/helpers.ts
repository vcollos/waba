import { createHash, randomUUID } from 'node:crypto';
import {
  ContactRecord,
  ParameterSource,
  TemplateMediaHeader,
  TemplateVariableDescriptor,
} from './types';

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

/** Extrai o mapa de exemplos (por token/índice) de um componente body/header da Meta. */
const componentExamples = (
  component: Record<string, unknown>,
  type: 'body' | 'header',
): { named: Record<string, string>; positional: string[] } => {
  const example = (component.example ?? {}) as Record<string, unknown>;
  const named: Record<string, string> = {};
  for (const entry of (example.body_text_named_params as Array<Record<string, unknown>>) ?? []) {
    if (entry?.param_name) {
      named[String(entry.param_name)] = String(entry.example ?? '');
    }
  }
  let positional: string[] = [];
  if (type === 'body') {
    const bt = example.body_text as unknown;
    positional = Array.isArray(bt) && Array.isArray(bt[0]) ? (bt[0] as unknown[]).map(String) : [];
  } else {
    const ht = example.header_text as unknown;
    positional = Array.isArray(ht) ? (ht as unknown[]).map(String) : [];
  }
  return { named, positional };
};

export const extractVariableDescriptors = (
  components: unknown[],
): TemplateVariableDescriptor[] => {
  const descriptors: TemplateVariableDescriptor[] = [];

  for (const component of components as Array<Record<string, unknown>>) {
    const type = String(component.type ?? '').toLowerCase();

    // BUTTONS: botões de URL dinâmica (url com {{n}}) exigem um parâmetro no envio.
    // Botão de URL estático (sem placeholder) não precisa de nada e é ignorado.
    if (type === 'buttons') {
      const buttons = Array.isArray(component.buttons) ? component.buttons : [];
      buttons.forEach((raw, index) => {
        const button = (raw ?? {}) as Record<string, unknown>;
        if (String(button.type ?? '').toUpperCase() !== 'URL') {
          return;
        }
        const url = typeof button.url === 'string' ? button.url : '';
        if (!url.includes('{{')) {
          return;
        }
        const example = Array.isArray(button.example) ? String(button.example[0] ?? '') : '';
        const buttonText = typeof button.text === 'string' ? button.text : '';
        // A Meta usa `http://business.facebook.com/{{1}}` como base-placeholder
        // para botões de URL TOTALMENTE dinâmica: o valor enviado é a URL de
        // destino inteira (com esquema), não um sufixo — não há base fixa real.
        const isFullUrl = /(^|\/\/)(www\.)?business\.facebook\.com\//i.test(url);
        descriptors.push({
          componentType: 'button',
          // `index` do botão no array (é o `index` que a Meta exige no envio).
          placeholderIndex: index,
          paramName: null,
          example: example || null,
          label: `Botão${buttonText ? ` · ${buttonText}` : ''}`,
          buttonSubType: 'url',
          buttonUrlBase: isFullUrl ? null : url,
          buttonFullUrl: isFullUrl,
        });
      });
      continue;
    }

    if (type !== 'body' && type !== 'header') {
      continue;
    }
    const text = typeof component.text === 'string' ? component.text : '';
    const examples = componentExamples(component, type);
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
      const example = positional
        ? examples.positional[Number(token) - 1] ?? null
        : examples.named[token] ?? null;
      descriptors.push({
        componentType: type as 'body' | 'header',
        placeholderIndex: positional ? Number(token) : ordinal,
        paramName: positional ? null : token,
        example: example || null,
        label: `${type.toUpperCase()} {{${token}}}`,
      });
    }
  }

  return descriptors;
};

/** Detecta um header de mídia (IMAGE/VIDEO/DOCUMENT) e sua URL de exemplo. */
export const extractTemplateMediaHeader = (
  components: unknown[],
): TemplateMediaHeader | null => {
  for (const component of (components as Array<Record<string, unknown>>) ?? []) {
    if (String(component.type ?? '').toUpperCase() !== 'HEADER') {
      continue;
    }
    const format = String(component.format ?? '').toUpperCase();
    if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
      const example = (component.example ?? {}) as Record<string, unknown>;
      const handle = Array.isArray(example.header_handle) ? example.header_handle[0] : undefined;
      return { format, example: handle ? String(handle) : null };
    }
  }
  return null;
};
