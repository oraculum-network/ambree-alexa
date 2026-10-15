// Synthetic MET Norway Locationforecast 2.0 (/complete) responses and GDACS event lists.

const HOUR = 3600_000;
const MU_OFFSET = 4 * HOUR;

export interface HourSpec {
  precip?: number;
  prob?: number | null;
  temp?: number;
  wind?: number;
  symbol?: string;
}

/** Hourly steps from `start` (UTC ms, on the hour), then a 6-hourly tail like the real feed. */
export function makeForecast(start: number, hours: number, spec: (muHour: number, time: number) => HourSpec = () => ({})) {
  const timeseries: unknown[] = [];
  for (let i = 0; i < hours; i++) {
    const t = start + i * HOUR;
    const s = spec(new Date(t + MU_OFFSET).getUTCHours(), t);
    const precip = s.precip ?? 0;
    const n1: Record<string, unknown> = { precipitation_amount: precip };
    if (s.prob !== null) n1.probability_of_precipitation = s.prob ?? (precip > 0 ? 70 : 5);
    timeseries.push({
      time: new Date(t).toISOString().replace(".000Z", "Z"),
      data: {
        instant: { details: { air_temperature: s.temp ?? 25, wind_speed: s.wind ?? 4, relative_humidity: 70 } },
        next_1_hours: { summary: { symbol_code: s.symbol ?? (precip >= 0.5 ? "rain" : "partlycloudy_day") }, details: n1 },
        next_6_hours: { summary: { symbol_code: "cloudy" }, details: { precipitation_amount: precip * 6, air_temperature_max: 27, air_temperature_min: 22 } },
      },
    });
  }
  for (let j = 0; j < 4; j++) {
    const t = start + (hours + j * 6) * HOUR;
    timeseries.push({
      time: new Date(t).toISOString().replace(".000Z", "Z"),
      data: { instant: { details: { air_temperature: 24, wind_speed: 5 } }, next_6_hours: { summary: { symbol_code: "cloudy" }, details: { precipitation_amount: 0 } } },
    });
  }
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [57.58, -20.01, 10] },
    properties: {
      meta: { updated_at: new Date(start - HOUR).toISOString().replace(".000Z", "Z"), units: { air_temperature: "celsius", precipitation_amount: "mm", wind_speed: "m/s" } },
      timeseries,
    },
  };
}

/** Rain of `mm` per hour between two Mauritius hours [from, to). */
export function rainBetween(from: number, to: number, mm = 2): (h: number) => HourSpec {
  return (h) => (h >= from && h < to ? { precip: mm } : {});
}

export interface GdacsSpec {
  id: number;
  name: string;
  alert: "Green" | "Orange" | "Red";
  lat: number;
  lon: number;
  current?: boolean;
  /** UTC ms of the latest advisory. */
  updated: number;
  countries?: string[];
}

export function makeGdacs(systems: GdacsSpec[]) {
  return {
    type: "FeatureCollection",
    features: systems.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        eventtype: "TC",
        eventid: s.id,
        name: s.name,
        alertlevel: s.alert,
        iscurrent: s.current === false ? "false" : "true",
        todate: new Date(s.updated).toISOString().slice(0, 19),
        severitydata: { severitytext: "Tropical Storm (maximum wind speed of 100 km/h)" },
        affectedcountries: (s.countries ?? []).map((iso3) => ({ iso3 })),
      },
    })),
  };
}
