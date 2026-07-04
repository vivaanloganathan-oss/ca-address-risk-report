/* Optional configuration. Safe to leave blank — the app works without it. */
window.APP_CONFIG = {
  // Free U.S. Census API key (instant signup: https://api.census.gov/data/key_signup.html).
  // When set, the ZIP demographics panel & factor #1 auto-populate. Leave '' to skip.
  CENSUS_KEY: '',
  // ACS 5-year vintage to query.
  ACS_YEAR: '2023',
  // Base URL of the self-hosted Map Shot server (see /server folder).
  // When set, the "Map Shots" section dynamically captures a live
  // screenshot of each search-only agency map with the address's ZIP
  // typed into that site's own search box. Leave '' to skip — the
  // section is hidden and those factors keep their existing map links.
  MAPSHOT_API_BASE: ''
};
