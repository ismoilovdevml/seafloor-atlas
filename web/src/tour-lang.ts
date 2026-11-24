// Which language the guided tour speaks: `#lang=uz` / `#lang=en` in the address wins, otherwise the browser's
// first preferred language. Only the tour is translated; the rest of the interface stays English.
export type TourLang = 'en' | 'uz';

export function tourLang(languages: readonly string[], hash: string): TourLang {
  const m = /(?:^#|[#&])lang=(en|uz)(?:&|$)/.exec(hash);
  if (m) return m[1] as TourLang;
  return (languages[0] ?? '').toLowerCase().startsWith('uz') ? 'uz' : 'en';
}

/** `#lang=` as written in the address, or null when it names none. */
export function langFromHash(hash: string): TourLang | null {
  return (/(?:^#|[#&])lang=(en|uz)(?:&|$)/.exec(hash)?.[1] as TourLang | undefined) ?? null;
}

/** The hash with `lang=<l>` set (replacing any earlier one), the other parts kept in order. */
export function hashWithLang(hash: string, lang: TourLang): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('lang='));
  parts.push(`lang=${lang}`);
  return `#${parts.join('&')}`;
}
