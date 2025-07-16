# Subsplash Calendar Subscription Service

A Cloudflare Worker that converts Subsplash calendar data to standard ICS/iCal format, enabling synchronization with Google Calendar, Apple Calendar, Outlook, and other calendar applications.

## Overview

Subsplash provides event management for churches and organizations but lacks native calendar subscription support. This service bridges that gap by:
- Automatically discovering all calendars on a Subsplash site
- Converting events to standard ICS/iCal format
- Providing subscription URLs that auto-update in calendar apps
- Supporting both individual calendars and combined feeds

## Features

- **Calendar Discovery**: Automatically finds all calendars on any Subsplash-powered site
- **Multiple Formats**: Subscribe to individual calendars or all calendars combined
- **Smart Caching**: Graduated cache TTLs based on event proximity for optimal performance
- **Timezone Support**: Automatic timezone detection with proper VTIMEZONE definitions
- **Event Enhancement**: Fetches full event details including descriptions and locations
- **Clean URLs**: Simple, memorable subscription URLs (e.g., `/domain.com/calendar-name.ics`)
- **Preview Cards**: Shows upcoming events before subscribing
- **Shareable Results**: Discovery results have permanent URLs for easy sharing

## Quick Start

Visit https://subsplash-ical.heathdutton.workers.dev and enter any Subsplash calendar URL to get started.

### Example Subscription URLs

```
# All calendars combined
https://subsplash-ical.heathdutton.workers.dev/yourchurch.com.ics

# Individual calendar
https://subsplash-ical.heathdutton.workers.dev/yourchurch.com/youth-events.ics
```

## How to Subscribe

### Copy Link Method (Recommended)
Best for ongoing synchronization - your calendar will automatically update with new events.

**Google Calendar:**
1. Open Google Calendar
2. Click + next to "Other calendars"
3. Select "From URL"
4. Paste the subscription URL
5. Click "Add calendar"

**Apple Calendar (Mac):**
1. Open Calendar app
2. File → New Calendar Subscription
3. Paste the URL and click Subscribe
4. Set refresh frequency (hourly recommended)

**Apple Calendar (iPhone/iPad):**
1. Go to Settings → Calendar → Accounts
2. Add Account → Other → Add Subscribed Calendar
3. Paste the URL and click Next
4. Configure settings and Save

**Outlook:**
1. Go to Outlook.com or open Outlook app
2. Add calendar → Subscribe from web
3. Paste the URL
4. Name your calendar and save

### Download Method
For one-time import of current events (won't automatically update).

## Technical Details

### Supported Timezones
- America/New_York (Eastern)
- America/Chicago (Central)
- America/Denver (Mountain)
- America/Los_Angeles (Pacific)

### Cache Strategy
- **Current week events**: 1 hour cache
- **Next 30 days**: 6 hours cache
- **31-90 days out**: 24 hours cache
- **Beyond 90 days**: 72 hours cache

### API Endpoints

```
# Calendar discovery
GET /api/discover?url=https://yourchurch.com

# Direct calendar access
GET /{domain}.ics              # All calendars
GET /{domain}/{calendar}.ics   # Specific calendar
```

## Development

### Prerequisites
- Node.js 18+
- Cloudflare account
- Wrangler CLI

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/subsplash-ical.git
   cd subsplash-ical
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure KV namespace in `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "SUBSPLASH_ICAL"
   id = "YOUR_KV_NAMESPACE_ID"
   ```

4. Run locally:
   ```bash
   npm run dev
   ```

5. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

### Cache Management

The service uses intelligent cache versioning:
- Cache keys include version numbers for easy invalidation
- Deployment automatically updates cache version
- Manual cache flush: `npm run cache:update && npm run deploy`

## Troubleshooting

### Calendar Not Found
- Verify the site has a Subsplash calendar (not just event listings)
- Try the root domain if a specific page doesn't work
- Check if events are publicly visible

### Wrong Timezone
- The service attempts to detect timezone from event data
- Falls back to Eastern time if detection fails
- All major US timezones are supported

### Missing Events
- Only future events appear in preview cards
- ICS files include all events (past and future)
- Check if events are published and public

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

This service is not affiliated with Subsplash. It's an independent tool created to improve calendar integration for Subsplash users.