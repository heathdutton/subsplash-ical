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
- **Event Enhancement**: Fetches full event details including descriptions and locations
- **Clean URLs**: Simple, memorable subscription URLs (e.g., `/domain.com/calendar-name.ics`)
- **Preview Cards**: Shows upcoming events before subscribing

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

### Subscribe (Recommended)
Your calendar will automatically sync with new events:

- **Google Calendar:** Click + next to "Other calendars" → "From URL" → Paste URL
- **Apple Calendar:** File → New Calendar Subscription → Paste URL
- **Outlook:** Add calendar → Subscribe from web → Paste URL

### Download
For one-time import (won't auto-update): Simply download the .ics file and import it.

## Technical Details

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
- Cloudflare account with Wrangler CLI

### Setup

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy
```

Configure your KV namespace in `wrangler.json` before deploying. Deployment automatically updates the cache version for invalidation.

## Troubleshooting

### Calendar Not Found
- Verify the site has a Subsplash calendar (not just event listings)
- Try the root domain if a specific page doesn't work
- Check if events are publicly visible

### Missing Events
- Only future events appear in preview cards
- ICS files include all events (past and future)
- Check if events are published and public

## License

MIT License - see LICENSE file for details

This service is not affiliated with Subsplash. It's an independent tool created to improve calendar integration for Subsplash users.