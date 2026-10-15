# Notices

Ambree for Alexa+ is MIT-licensed (see `LICENSE`). It bundles or uses the following.

## Fonts (SIL Open Font License 1.1)

Self-hosted in `public/fonts/`, each with its licence file next to it:

- **Instrument Serif** (regular and italic): `public/fonts/OFL-InstrumentSerif.txt`
- **Instrument Sans**: `public/fonts/OFL-InstrumentSans.txt`
- **IBM Plex Mono**: `public/fonts/OFL-IBMPlexMono.txt`

## Weather: MET Norway

Forecasts come from the MET Norway Locationforecast 2.0 API. **Data from MET Norway**, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We summarise it: we pick hours, count rainy
hours and turn them into spoken advice. The `weather_now` and `replan_day` results carry the credit in
`attribution.weather`, and the voice page shows it in the footer.

## Cyclone alerts: GDACS

Tropical cyclone alerts come from GDACS, the Global Disaster Alert and Coordination System (a cooperation
of the United Nations and the European Commission). GDACS data is automatic and is not an official warning,
so Ambree always tells travellers to follow the official cyclone bulletins from the Mauritius
Meteorological Services.

## Places dataset

`data/places.json` was curated for Ambree from the sources cited in each record's `source` field. It
contains facts plus our own words (each `blurb` and `speech` is written by us).

## Brand

The Ambree name, logo and lockup (`public/ambree-*.svg`, `public/favicon.svg`) belong to the Ambree
authors. The MIT licence covers the code, not the brand.
