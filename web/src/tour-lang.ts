// Which language the guided tour speaks: `#lang=uz` / `#lang=en` in the address wins, otherwise the browser's
// first preferred language. Only the tour is translated; the rest of the interface stays English.
export type TourLang = 'en' | 'uz';

export function tourLang(languages: readonly string[], hash: string): TourLang {
  const m = /(?:^#|[#&])lang=(en|uz)(?:&|$)/.exec(hash);
  if (m) return m[1] as TourLang;
  return (languages[0] ?? '').toLowerCase().startsWith('uz') ? 'uz' : 'en';
}
