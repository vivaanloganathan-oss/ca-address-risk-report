/* Optional configuration. Safe to leave blank — the app works without it. */
window.APP_CONFIG = {
  BUILD: 'b80-live-stripe-payment-link-2026-07-18',
  // Free U.S. Census API key (instant signup: https://api.census.gov/data/key_signup.html).
  // When set, the ZIP demographics panel & factor #1 auto-populate. Leave '' to skip.
  CENSUS_KEY: '17131a6e464af27065bf5f42fbbb0d1c3b3872a4',
  // ACS 5-year vintage to query.
  ACS_YEAR: '2023',
  // Base URL of the self-hosted Map Shot server (see /server folder).
  // When set, the "Map Shots" section dynamically captures a live
  // screenshot of each search-only agency map with the address's ZIP
  // typed into that site's own search box. Leave '' to skip — the
  // section is hidden and those factors keep their existing map links.
  MAPSHOT_API_BASE: 'https://ca-address-risk-report.onrender.com',
  // Optional Stripe-hosted donation / payment link shown before PDF download.
  // Create a Stripe Payment Link or Checkout link and paste it here. Leave blank to disable.
  STRIPE_DONATION_URL: 'https://buy.stripe.com/28E14n6qJdXi16fc2v8N200'
};
