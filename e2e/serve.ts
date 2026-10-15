// The e2e server: mock MET Norway (3872) and GDACS (3873) feeds, then the app on 3871
// with the passcode gate on and no OpenRouter key (offline mode). Never touches the real APIs.

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { makeForecast, makeGdacs, rainBetween } from "../test/helpers/forecast.ts";
import { json, startMockServer } from "../test/helpers/mock-server.ts";

export const E2E_PASSCODE = "e2e-passcode-not-real";
const HOUR = 3600_000;

// Rain over the island from noon to five, Mauritius time, whatever day it is.
const met = await startMockServer((_req, res) => {
  const start = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  json(res, 200, makeForecast(start, 60, rainBetween(12, 17, 1.6)), { Expires: new Date(Date.now() + 30 * 60_000).toUTCString() });
}, 3872);
const gdacs = await startMockServer((_req, res) => json(res, 200, makeGdacs([])), 3873);

const config = loadConfig({
  PORT: "3871",
  HOST: "127.0.0.1",
  DEMO_PASSCODE: E2E_PASSCODE,
  SESSION_SECRET: "e2e-session-secret-not-real-0123456789",
  MET_URL: `${met.url}/weatherapi/locationforecast/2.0/complete`,
  GDACS_URL: `${gdacs.url}/gdacsapi/api/events/geteventlist/SEARCH`,
  RATE_LIMIT_SCALE: "20",
});
const app = createApp({ config, logger: () => {} });
await app.listen();
process.stdout.write("e2e server ready on 3871\n");

const stop = async () => {
  await app.close();
  await met.close();
  await gdacs.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
