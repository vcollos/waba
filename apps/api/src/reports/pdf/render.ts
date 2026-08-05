import { createElement } from 'react';
import { Font, renderToBuffer } from '@react-pdf/renderer';
import { assertPdfFontsExist, fonts } from './assets';
import { ReportDocument, type ReportDocumentProps } from './report-document';

/**
 * Registro de fontes + render do PDF do relatório de campanhas (WABA-25).
 *
 * Fontes são registradas UMA vez (guarda `registered`) usando os caminhos
 * runtime-safe de `assets.ts`. `assertPdfFontsExist()` roda no primeiro render
 * (fail-fast) para acusar build sem o passo copy-pdf-assets. react-pdf também
 * precisa de um hyphenation callback trivial p/ não quebrar palavras longas
 * (UUIDs, e-mails) no meio.
 */
let registered = false;

function registerFontsOnce(): void {
  if (registered) {
    return;
  }
  assertPdfFontsExist();

  Font.register({
    family: 'Manrope',
    fonts: [
      { src: fonts.manrope.regular, fontWeight: 400 },
      { src: fonts.manrope.medium, fontWeight: 500 },
      { src: fonts.manrope.semibold, fontWeight: 600 },
      { src: fonts.manrope.bold, fontWeight: 700 },
      { src: fonts.manrope.extrabold, fontWeight: 800 },
    ],
  });

  Font.register({
    family: 'IBMPlexMono',
    fonts: [
      { src: fonts.ibmPlexMono.regular, fontWeight: 400 },
      { src: fonts.ibmPlexMono.medium, fontWeight: 500 },
      { src: fonts.ibmPlexMono.semibold, fontWeight: 600 },
    ],
  });

  // Não hifenizar: mantém UUIDs/e-mails/valores inteiros.
  Font.registerHyphenationCallback((word) => [word]);

  registered = true;
}

/** Renderiza o Document react-pdf e devolve o Buffer do PDF. */
export async function renderCampaignsReportPdf(props: ReportDocumentProps): Promise<Buffer> {
  registerFontsOnce();
  // O elemento é um function-component que retorna <Document>; o tipo do
  // parâmetro de renderToBuffer espera DocumentProps, daí o cast controlado.
  const element = createElement(ReportDocument, props) as Parameters<typeof renderToBuffer>[0];
  return renderToBuffer(element);
}
