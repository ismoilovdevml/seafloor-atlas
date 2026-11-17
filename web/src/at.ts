// `#at=lon,lat[,zoom]` deep link: opens the globe at a place (used by the static EEZ report-card pages).
export interface At { lon: number; lat: number; zoom: number }

const RE = /(?:^#|[#&])at=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:&|$)/;

export function atFromHash(hash: string): At | null {
  const m = RE.exec(hash);
  if (!m) return null;
  const lon = Number(m[1]); const lat = Number(m[2]);
  const zoom = m[3] === undefined ? 4 : Number(m[3]);
  if (!(lon >= -180 && lon <= 180 && lat >= -85 && lat <= 85 && zoom >= 0 && zoom <= 12)) return null;
  return { lon, lat, zoom };
}
