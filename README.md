# Subsplash iCal Worker

A Cloudflare Worker that converts Subsplash calendar events to iCal format for easy synchronization with Google Calendar, Apple Calendar, and other calendar applications.

## Features

- Fetches events from Subsplash calendar API
- Converts events to standard iCal format
- Caching support for improved performance
- Supports filtering by calendar ID
- Proper handling of all-day events
- Compatible with all major calendar applications

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your KV namespace in `wrangler.toml` (optional, for caching):
   ```toml
   [[kv_namespaces]]
   binding = "CACHE"
   id = "YOUR_KV_NAMESPACE_ID"
   ```

3. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## User Interface

The worker includes a built-in UI for generating calendar links. Simply visit your worker URL without any parameters to access the link generator:

```
https://your-worker.workers.dev/
```

The UI allows users to:
- Paste their Subsplash calendar URL
- Optionally specify a calendar ID
- Generate subscription links
- Get embed code for their Subsplash site
- Copy links for different calendar applications

## Usage

Once deployed, access your calendar feed at:

```
https://your-worker.workers.dev/?domain=yourchurch
```

Optional parameters:
- `calendar_id`: Filter events by specific calendar ID

### Example URLs:

- Basic calendar feed: `https://your-worker.workers.dev/?domain=yourchurch`
- Specific calendar: `https://your-worker.workers.dev/?domain=yourchurch&calendar_id=12345`

### Adding to Calendar Apps:

**Google Calendar:**
1. Open Google Calendar
2. Click the + next to "Other calendars"
3. Select "From URL"
4. Paste your worker URL
5. Click "Add calendar"

**Apple Calendar:**
1. Open Calendar app
2. File → New Calendar Subscription
3. Enter your worker URL
4. Configure refresh frequency

**Outlook:**
1. Go to Outlook.com
2. Add calendar → Subscribe from web
3. Enter your worker URL
4. Name your calendar and save

## Development

Run locally with:
```bash
npm run dev
```

## API Notes

The worker expects Subsplash API to return events with the following structure:
- `id`: Event identifier
- `title` or `name`: Event title
- `start_time` or `start_date`: Event start
- `end_time` or `end_date`: Event end
- `description`: Event description (optional)
- `location` or `venue`: Event location (optional)
- `all_day`: Boolean for all-day events
- `url` or `link`: Event URL (optional)

## Troubleshooting

If the calendar feed isn't working:

1. Verify the domain parameter is correct
2. Check that the Subsplash site has public calendar events
3. Look at the worker logs in Cloudflare dashboard
4. Ensure the API endpoint format matches your Subsplash instance

## License

MIT