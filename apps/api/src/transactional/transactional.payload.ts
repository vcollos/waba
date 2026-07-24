import { normalizePhone } from '../database/helpers';
import { TemplateCacheRecord } from '../database/types';

/**
 * Monta o payload de template da Meta para um disparo transacional, recebendo os
 * valores DIRETO da API (sem contato/campanha). Espelha
 * `CampaignsService.buildTemplatePayload`, mas resolve as variáveis a partir de
 * um mapa `{ [paramName | placeholderIndex]: valor }`.
 *
 * - NAMED: `variables[descriptor.paramName]`; POSICIONAL: `variables[String(index)]`.
 * - Templates NAMED exigem `parameter_name` em cada parâmetro.
 * - Ordena por `placeholderIndex` dentro de cada componente (header/body).
 */
export const buildTransactionalTemplatePayload = (
  template: TemplateCacheRecord,
  to: string,
  variables: Record<string, string>,
): Record<string, unknown> => {
  const { phoneE164 } = normalizePhone(to);

  const resolveValue = (descriptor: TemplateCacheRecord['variableDescriptors'][number]): string => {
    if (descriptor.paramName && variables[descriptor.paramName] != null) {
      return variables[descriptor.paramName];
    }
    const positional = variables[String(descriptor.placeholderIndex)];
    return positional != null ? positional : '';
  };

  const toParameter = (descriptor: TemplateCacheRecord['variableDescriptors'][number]) => ({
    type: 'text',
    ...(descriptor.paramName ? { parameter_name: descriptor.paramName } : {}),
    text: resolveValue(descriptor),
  });

  const bodyParameters = template.variableDescriptors
    .filter((descriptor) => descriptor.componentType === 'body')
    .sort((left, right) => left.placeholderIndex - right.placeholderIndex)
    .map(toParameter);

  const headerParameters = template.variableDescriptors
    .filter((descriptor) => descriptor.componentType === 'header')
    .sort((left, right) => left.placeholderIndex - right.placeholderIndex)
    .map(toParameter);

  const components: Record<string, unknown>[] = [];
  if (headerParameters.length > 0) {
    components.push({ type: 'header', parameters: headerParameters });
  }
  if (bodyParameters.length > 0) {
    components.push({ type: 'body', parameters: bodyParameters });
  }

  // Categoria AUTHENTICATION (OTP): o template de código da Meta inclui um botão
  // "copy code" que TAMBÉM exige o código como parâmetro. O código vem de
  // `variables.code` ou, na ausência, do 1º parâmetro de body.
  // ATENÇÃO: validar contra o template aprovado REAL — o sub_type pode variar
  // entre 'url' e 'copy_code' e o index pode diferir. Não quebrar se não houver
  // código disponível.
  if (String(template.category).toUpperCase() === 'AUTHENTICATION') {
    const code =
      (variables.code != null ? variables.code : undefined) ??
      (bodyParameters[0]?.text as string | undefined);
    if (code) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      });
    }
  }

  return {
    messaging_product: 'whatsapp',
    to: phoneE164.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.languageCode },
      components,
    },
  };
};

/**
 * Descritores (body/header) sem valor em `variables`. Chamado ANTES de montar o
 * payload/enviar à Meta: variável faltando viraria `text:''` e a Meta rejeita
 * 422. Devolve os rótulos legíveis dos faltantes.
 */
export const collectMissingVariables = (
  template: TemplateCacheRecord,
  variables: Record<string, string>,
): string[] => {
  const missing: string[] = [];
  for (const descriptor of template.variableDescriptors) {
    // Botões de URL dinâmica são um conceito de campanha; no fluxo transacional o
    // botão (copy_code) é resolvido pelo caso AUTHENTICATION, não por descritor.
    if (descriptor.componentType === 'button') {
      continue;
    }
    const named = descriptor.paramName ? variables[descriptor.paramName] : undefined;
    const positional = variables[String(descriptor.placeholderIndex)];
    const value = named != null ? named : positional;
    if (value == null || value === '') {
      missing.push(descriptor.paramName ?? descriptor.label);
    }
  }
  return missing;
};

/**
 * Redige o payload para PERSISTÊNCIA: mascara os textos das variáveis (body,
 * header e botão copy_code) com `***`. O código OTP/token só existe em memória
 * para o envio; o que fica no banco (`record_json` + `payloadHash`) não permite
 * recuperar o valor. Estrutura (nome/idioma/componentes) é preservada.
 */
export const redactTransactionalPayload = (
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const clone = structuredClone(payload) as Record<string, unknown>;
  const template = clone.template as Record<string, unknown> | undefined;
  const components = Array.isArray(template?.components) ? template!.components : [];
  for (const rawComponent of components as Array<Record<string, unknown>>) {
    const parameters = Array.isArray(rawComponent.parameters) ? rawComponent.parameters : [];
    for (const rawParam of parameters as Array<Record<string, unknown>>) {
      if (typeof rawParam.text === 'string') {
        rawParam.text = '***';
      }
    }
  }
  return clone;
};
