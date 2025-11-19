import { CACHE_VERSION } from '../cache_version.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Check for calendar discovery API
    if (url.pathname === '/api/discover' && url.searchParams.has('url')) {
      return await handleDiscoveryRequest(url.searchParams.get('url'), env);
    }
    
    // Check for /{domain}/{calendar_name}.ics pattern
    const calendarMatch = url.pathname.match(/^\/([^\/]+)\/([^\/]+)\.ics$/);
    if (calendarMatch) {
      const [, domain, calendarName] = calendarMatch;
      return await handleICalRequest(domain, env, decodeURIComponent(calendarName));
    }
    
    // Check for /{domain}.ics pattern (all calendars)
    const icsMatch = url.pathname.match(/^\/([^\/]+)\.ics$/);
    if (icsMatch) {
      const domain = icsMatch[1];
      return await handleICalRequest(domain, env);
    }
    
    // Check for /{domain} pattern (show discovery results)
    // Match domain names but not files with extensions like .js, .css, .ico
    const domainMatch = url.pathname.match(/^\/([^\/]+)$/);
    if (domainMatch) {
      const domain = domainMatch[1];
      // Skip if it's a file (has common file extensions)
      const fileExtensions = ['.js', '.css', '.ico', '.png', '.jpg', '.gif', '.svg', '.json', '.xml', '.txt'];
      const isFile = fileExtensions.some(ext => domain.toLowerCase().endsWith(ext));
      
      if (!isFile && !domain.endsWith('.ics')) {
        return serveUI(domain);
      }
    }
    
    // Serve the UI for root path
    if (url.pathname === '/') {
      return serveUI();
    }
    
    return new Response('Not found', { status: 404 });
  }
};

async function handleICalRequest(domain, env, calendarName = null) {
  try {
    // Build cache key based on whether we want a specific calendar
    const cacheKey = calendarName 
      ? `ics:${domain}:${calendarName}:v${CACHE_VERSION}`
      : `ics:${domain}:all:v${CACHE_VERSION}`;
    
    const cached = await env.SUBSPLASH_ICAL?.get(cacheKey, { type: 'json' });
    
    if (cached) {
      const { data, metadata } = cached;
      const now = Date.now();
      
      // Check if data should be refreshed
      if (metadata && metadata.refreshAfter && now < metadata.refreshAfter) {
        // Data is still fresh
        return new Response(data, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${domain}${calendarName ? '-' + calendarName : ''}-calendar.ics"`,
            'Cache-Control': 'public, max-age=3600' // 1 hour
          }
        });
      }
      // If stale, we'll try to regenerate below
    }
    
    // If requesting a specific calendar, check if we have cached events data
    if (calendarName && env.SUBSPLASH_ICAL) {
      const eventsDataKey = `events-data:${domain}:all:v${CACHE_VERSION}`;
      const cachedEventsData = await env.SUBSPLASH_ICAL.get(eventsDataKey, { type: 'json' });
      
      if (cachedEventsData) {
        try {
          let events = cachedEventsData.data || cachedEventsData; // Handle both old and new format
          
          // Filter by calendar name
          events = events.filter(event => {
            const eventCalendarName = event.calendar ||
                                   event.calendar_name || 
                                   event.calendarName || 
                                   event.calendar?.name ||
                                   event.calendar?.title ||
                                   event.category ||
                                   event.categoryName ||
                                   event.category_name ||
                                   '';
            return normalizeCalendarName(eventCalendarName) === normalizeCalendarName(calendarName);
          });
          
          if (events.length > 0) {
            // Generate ICS and cache it
            const icalContent = generateICal(events, domain, calendarName);
            const cacheData = {
              data: icalContent,
              metadata: {
                refreshAfter: Date.now() + (3600 * 1000), // Refresh after 1 hour
                cachedAt: Date.now(),
                domain,
                calendarName
              }
            };
            await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify(cacheData), {
              expirationTtl: 604800 // Keep for 7 days
            });
            
            return new Response(icalContent, {
              headers: {
                'Content-Type': 'text/calendar; charset=utf-8',
                'Content-Disposition': `attachment; filename="${domain}${calendarName ? '-' + calendarName : ''}-calendar.ics"`,
                'Cache-Control': 'public, max-age=3600'
              }
            });
          }
        } catch (e) {
          console.error('Failed to use cached events data:', e);
        }
      }
    }
    
    // Discover the website_id from the domain
    const siteInfo = await discoverSiteInfo(domain);
    if (!siteInfo) {
      return new Response('Unable to find calendar for this site', { status: 404 });
    }
    
    // Fetch all events for the next year
    let events = await fetchAllSubsplashEvents(domain, siteInfo.websiteId, siteInfo.baseUrl, env);
    
    // Cache the complete events data for reuse
    if (env.SUBSPLASH_ICAL && events.length > 0) {
      const eventsDataKey = `events-data:${domain}:all:v${CACHE_VERSION}`;
      const cacheData = {
        data: events,
        metadata: {
          refreshAfter: Date.now() + (3600 * 1000), // Refresh after 1 hour
          cachedAt: Date.now(),
          domain
        }
      };
      await env.SUBSPLASH_ICAL.put(eventsDataKey, JSON.stringify(cacheData), {
        expirationTtl: 604800 // Keep for 7 days
      });
    }
    
    // Filter by calendar name if specified
    if (calendarName) {
      events = events.filter(event => {
        const eventCalendarName = event.calendar_name || 
                                 event.calendarName || 
                                 event.calendar?.name ||
                                 event.calendar?.title ||
                                 event.category ||
                                 event.categoryName ||
                                 event.category_name ||
                                 '';
        return normalizeCalendarName(eventCalendarName) === normalizeCalendarName(calendarName);
      });
      
      if (events.length === 0) {
        // Redirect to all calendars for this domain
        const allCalendarsUrl = `/${domain}.ics`;
        return new Response(null, {
          status: 302,
          headers: {
            'Location': allCalendarsUrl,
            'Cache-Control': 'no-cache'
          }
        });
      }
    }
    
    // Convert to ICS format
    const icalContent = generateICal(events, domain, calendarName);
    
    // Cache the result for 1 hour
    if (env.SUBSPLASH_ICAL) {
      const cacheData = {
        data: icalContent,
        metadata: {
          refreshAfter: Date.now() + (3600 * 1000), // Refresh after 1 hour
          cachedAt: Date.now(),
          domain,
          calendarName
        }
      };
      await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify(cacheData), {
        expirationTtl: 604800 // Keep for 7 days
      });
    }
    
    return new Response(icalContent, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${domain}${calendarName ? '-' + calendarName : ''}-calendar.ics"`,
        'Cache-Control': 'public, max-age=3600'
      }
    });
    
  } catch (error) {
    console.error('Error generating ICS:', error);
    
    // Try to serve stale cached data if available
    if (env.SUBSPLASH_ICAL) {
      const cached = await env.SUBSPLASH_ICAL.get(cacheKey, { type: 'json' });
      if (cached && cached.data) {
        console.log('Serving stale cached data due to error');
        return new Response(cached.data, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${domain}${calendarName ? '-' + calendarName : ''}-calendar.ics"`,
            'Cache-Control': 'public, max-age=300', // 5 minutes for stale data
            'X-Cache-Status': 'stale' // Indicate this is stale data
          }
        });
      }
    }
    
    return new Response('Error generating calendar feed', { status: 500 });
  }
}

async function handleDiscoveryRequest(calendarUrl, env) {
  // Extract domain from URL
  console.log('Received calendarUrl:', calendarUrl);
  
  let url, domain;
  try {
    url = new URL(calendarUrl);
    domain = url.hostname;
  } catch (error) {
    console.error('Invalid URL:', calendarUrl, error);
    return new Response(JSON.stringify({ error: 'Invalid URL provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    
    // Check cache for calendar list
    const cacheKey = `calendars:${domain}:v${CACHE_VERSION}`;
    const cached = await env.SUBSPLASH_ICAL?.get(cacheKey, { type: 'json' });
    
    if (cached) {
      const { data, metadata } = cached;
      const now = Date.now();
      
      // Check if data should be refreshed
      if (metadata && metadata.refreshAfter && now < metadata.refreshAfter) {
        // Data is still fresh
        return new Response(JSON.stringify(data), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }
      // If stale, continue to refresh
    }
    
    // Discover website ID from domain
    console.log('Starting discovery for domain:', domain);
    let siteInfo;
    try {
      siteInfo = await discoverSiteInfo(domain);
    } catch (error) {
      console.error('Error during site discovery:', error);
      return new Response(JSON.stringify({ 
        error: 'Unable to discover site info',
        details: error.message 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!siteInfo) {
      console.log('No site info found for domain:', domain);
      return new Response(JSON.stringify({ error: 'Unable to find calendar data' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log('Site info discovered:', siteInfo);
    
    // Fetch a sample of recent events to discover calendars (not all events)
    const events = await fetchSampleEventsForCalendarDiscovery(domain, siteInfo.websiteId, siteInfo.baseUrl, env);
    console.log('Sample events fetched:', events.length);
    
    // Extract unique calendars
    const calendarsMap = new Map();
    const now = new Date(); // Define now here for use in the loop
    
    // Debug: Log sample event structure
    if (events.length > 0) {
      console.log('Sample event structure for calendar discovery:', JSON.stringify(events[0], null, 2));
      console.log('Total events found:', events.length);
    }
    
    events.forEach((event, index) => {
      // Debug: Log first few events to see what fields are available
      if (index < 3) {
        console.log(`Event ${index + 1}:`, {
          calendar_name: event.calendar_name,
          calendarName: event.calendarName,
          calendar: event.calendar,
          category: event.category,
          categoryName: event.categoryName,
          category_name: event.category_name,
          // Check for any other potential calendar fields
          eventCategory: event.eventCategory,
          event_category: event.event_category,
          type: event.type,
          eventType: event.eventType,
          event_type: event.event_type,
          group: event.group,
          groupName: event.groupName,
          group_name: event.group_name
        });
      }
      
      // Try various possible field names for calendar information
      const calendarName = event.calendar ||
                          event.calendar_name || 
                          event.calendarName || 
                          event.calendar?.name ||
                          event.calendar?.title ||
                          event.category ||
                          event.categoryName ||
                          event.category_name ||
                          null;
      
      // Debug: Log what calendar name we found
      if (index < 3) {
        console.log(`Calendar name found for event ${index + 1}:`, calendarName);
      }
      
      // Only use a calendar name if we found one, don't default to "Default"
      if (calendarName) {
        if (!calendarsMap.has(calendarName)) {
          calendarsMap.set(calendarName, {
            name: calendarName,
            normalized: normalizeCalendarName(calendarName),
            eventCount: 0, // Will be updated when actually fetching iCal
            sampleEvents: []
          });
        }
        const calendar = calendarsMap.get(calendarName);
        
        // Count all events (not just future)
        calendar.eventCount++;
        
        // Add up to 3 sample FUTURE events per calendar for preview
        const eventDate = parseEventDate(event.start || event.startDate || event.start_date);
        if (eventDate && eventDate >= now && calendar.sampleEvents.length < 3) {
          calendar.sampleEvents.push({
            title: event.title || event.name || event.event_name || 'Event',
            start: event.start || event.startDate || event.start_date,
            end: event.end || event.endDate || event.end_date,
            allDay: event.allDay || event.all_day || false
          });
        }
      } else {
        // Debug: Log events without calendar names
        if (index < 3) {
          console.log(`No calendar name found for event ${index + 1}. Full event:`, event);
        }
      }
    });
    
    // Get all calendars, but track which ones have future events
    const allCalendars = Array.from(calendarsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    
    // For discovery, show calendars even if they only have past events
    // The actual ICS generation will include all events (past and future)
    const calendars = allCalendars;
    
    // Debug: Log calendar discovery results
    console.log('Calendar discovery results:', {
      totalEvents: events.length,
      calendarsFound: calendars.length,
      calendars: calendars.map(c => ({ name: c.name, eventCount: c.eventCount }))
    });
    
    // Get future events for checking
    const futureEvents = events.filter(event => {
      const eventDate = parseEventDate(event.start || event.startDate || event.start_date);
      return eventDate && eventDate >= now;
    });
    
    // Note if all events are past but don't block discovery
    if (futureEvents.length === 0 && events.length > 0) {
      console.log(`All ${events.length} events are in the past for ${domain}, but showing calendars anyway`);
    }
    
    // Check if we found any events at all
    if (events.length === 0 && !url.pathname.includes('/events')) {
      // Try fallback to domain root if user provided a specific page URL
      console.log('No events found, trying domain root as fallback');
      
      // Extract just the domain without path
      const rootDomain = domain.replace(/^https?:\/\//, '').split('/')[0];
      const rootSiteInfo = await discoverSiteInfo(rootDomain);
      
      if (rootSiteInfo) {
        const rootEvents = await fetchSampleEventsForCalendarDiscovery(rootDomain, rootSiteInfo.websiteId, rootSiteInfo.baseUrl, env);
        
        if (rootEvents.length > 0) {
          // Redirect to root domain discovery
          return new Response(JSON.stringify({
            redirect: true,
            suggestedUrl: `https://${rootDomain}/`,
            message: 'No calendar found at the provided URL. Found calendars at the site root instead.'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // No events found anywhere
      return new Response(JSON.stringify({
        error: 'No calendar events found',
        message: 'No calendar events were found at this URL. Please provide a URL to a page that displays a Subsplash calendar.',
        totalEvents: 0,
        calendars: [],
        domain
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get sample events for "All Calendars" view - only future events
    const allSampleEvents = futureEvents.slice(0, 3).map(event => ({
      title: event.title || event.name || event.event_name || 'Event',
      start: event.start || event.startDate || event.start_date,
      end: event.end || event.endDate || event.end_date,
      allDay: event.allDay || event.all_day || false,
      calendar: event.calendar || event.calendar_name || event.calendarName || ''
    }));
    
    const result = {
      domain,
      websiteId: siteInfo.websiteId,
      calendars,
      totalEvents: events.length,
      sampleEvents: allSampleEvents,
      note: 'Preview shows upcoming events only'
    };
    
    const resultJson = JSON.stringify(result);
    
    // Cache the calendar list
    if (env.SUBSPLASH_ICAL && events.length > 0) {
      const cacheData = {
        data: result,
        metadata: {
          refreshAfter: Date.now() + (3600 * 1000), // Refresh after 1 hour
          cachedAt: Date.now(),
          domain
        }
      };
      await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify(cacheData), {
        expirationTtl: 604800 // Keep for 7 days
      });
    }
    
    return new Response(resultJson, {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
    
  } catch (error) {
    console.error('Error discovering calendars:', error);
    
    // Try to serve stale cached data if available
    if (env.SUBSPLASH_ICAL) {
      const cacheKey = `calendars:${domain}:v${CACHE_VERSION}`;
      const cached = await env.SUBSPLASH_ICAL.get(cacheKey, { type: 'json' });
      if (cached && cached.data) {
        console.log('Serving stale cached calendar list due to error');
        return new Response(JSON.stringify(cached.data), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300', // 5 minutes for stale data
            'X-Cache-Status': 'stale'
          }
        });
      }
    }
    
    return new Response(JSON.stringify({ 
      error: 'Failed to discover calendars',
      details: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function normalizeCalendarName(name) {
  // Normalize calendar name for URL usage
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function discoverSiteInfo(domain) {
  try {
    // Build the full URL - domain might be just the subdomain or full domain
    let eventsUrl;
    if (domain.includes('.')) {
      eventsUrl = `https://${domain}/events`;
    } else {
      eventsUrl = `https://${domain}.snappages.site/events`;
    }
    
    console.log('Attempting to discover site info from:', eventsUrl);
    
    const response = await fetch(eventsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)'
      }
    });
    
    if (!response.ok) {
      console.log('Failed to fetch events page:', response.status);
      return null;
    }
    
    const html = await response.text();
    
    // Look for website_id using the var wid= pattern
    const widPattern = /var\s+wid\s*=\s*(\d+)/i;
    const widMatch = html.match(widPattern);
    
    let websiteId = null;
    if (widMatch && widMatch[1]) {
      websiteId = widMatch[1];
      console.log('Found website ID using wid pattern:', websiteId);
    } else {
      // Fallback to other patterns
      const websiteIdPatterns = [
        /website_id["']?\s*[:=]\s*["']?(\d+)/i,
        /data-website-id=["'](\d+)["']/i,
        /websiteId["']?\s*[:=]\s*["']?(\d+)/i,
        /\/controllers\/events\?.*website_id=(\d+)/i
      ];
      
      for (const pattern of websiteIdPatterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          websiteId = match[1];
          console.log('Found website ID using fallback pattern:', websiteId);
          break;
        }
      }
    }
    
    if (!websiteId) {
      console.log('No website ID found in HTML. Checking for iframes...');
    }
    
    // If no website ID found, check for iframe pointing to snappages.site
    if (!websiteId) {
      // Look for iframes with snappages.site URLs
      const iframePattern = /<iframe[^>]*src=["']([^"']*snappages\.site[^"']*)["'][^>]*>/gi;
      const iframeMatches = html.matchAll(iframePattern);
      
      for (const match of iframeMatches) {
        const iframeUrl = match[1];
        console.log('Found Subsplash iframe:', iframeUrl);
        
        try {
          const iframeResponse = await fetch(iframeUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)'
            }
          });
          
          if (iframeResponse.ok) {
            const iframeHtml = await iframeResponse.text();
            
            // Extract website ID from the iframe content
            const iframeWidMatch = iframeHtml.match(widPattern);
            if (iframeWidMatch && iframeWidMatch[1]) {
              websiteId = iframeWidMatch[1];
              
              // Extract the domain from the iframe URL
              const iframeUrlObj = new URL(iframeUrl);
              const iframeDomain = iframeUrlObj.hostname;
              
              // Return with the iframe's domain as the base
              return {
                websiteId,
                baseUrl: `https://${iframeDomain}`,
                domain: iframeDomain
              };
            }
          }
        } catch (e) {
          console.error('Error fetching iframe content:', e);
        }
      }
    }
    
    if (!websiteId) {
      return null;
    }
    
    // Determine the base URL based on the domain format
    let baseUrl;
    if (domain.includes('.')) {
      baseUrl = `https://${domain}`;
    } else {
      baseUrl = `https://${domain}.snappages.site`;
    }
    
    return {
      websiteId,
      baseUrl,
      domain
    };
  } catch (error) {
    console.error('Error discovering site info:', error);
    return null;
  }
}

// Lightweight function to fetch sample events for calendar discovery
async function fetchSampleEventsForCalendarDiscovery(domain, websiteId, baseUrl, env) {
  try {
    // Fetch from current and next few months to get a good sample of calendars
    const now = new Date();
    const months = [];
    
    // Get current month and next 3 months for better calendar discovery
    for (let i = 0; i < 4; i++) {
      const date = new Date(now);
      date.setMonth(date.getMonth() + i);
      const month = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
      months.push(month);
    }
    const sampleEvents = [];
    
    for (const month of months) {
      // Only fetch first 30 events per month for discovery
      const monthEvents = await fetchMonthEvents(domain, websiteId, month, baseUrl, 30);
      console.log(`Found ${monthEvents.length} events for ${month}`);
      sampleEvents.push(...monthEvents);
      
      // If we have enough events to identify calendars, stop early
      if (sampleEvents.length >= 80) {
        break;
      }
    }
    
    // Sort events by start time for chronological order
    sampleEvents.sort((a, b) => {
      const dateA = new Date(a.startDate || a.start_date || a.start_time || a.start);
      const dateB = new Date(b.startDate || b.start_date || b.start_time || b.start);
      return dateA - dateB;
    });
    
    return sampleEvents;
  } catch (error) {
    console.error('Error fetching sample events for calendar discovery:', error);
    return [];
  }
}

async function fetchAllSubsplashEvents(domain, websiteId, baseUrl, env = null) {
  const now = new Date();
  const oneYearFromNow = new Date(now);
  oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
  
  // Generate array of months to fetch (YYYY-MM format)
  const months = [];
  const currentDate = new Date(now);
  currentDate.setDate(1); // Start from first day of month
  
  while (currentDate <= oneYearFromNow) {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
    currentDate.setMonth(currentDate.getMonth() + 1);
  }
  
  // Fetch all months in parallel
  const monthPromises = months.map(async (month) => {
    // Check cache first if env is provided
    if (env && env.SUBSPLASH_ICAL) {
      const cacheKey = `events:${domain}:${month}:v${CACHE_VERSION}`;
      const cached = await env.SUBSPLASH_ICAL.get(cacheKey, { type: 'json' });
      
      if (cached) {
        const { data, metadata } = cached;
        const now = Date.now();
        
        // Check if data should be refreshed (soft expiration)
        if (metadata && metadata.refreshAfter && now < metadata.refreshAfter) {
          // Data is still fresh, use it
          return data;
        }
        
        // Data needs refresh, but we'll try to fetch new data
        // If fetch fails, we'll use this stale data
        try {
          const monthEvents = await fetchMonthEvents(domain, websiteId, month, baseUrl);
          await cacheMonthEvents(env, domain, month, monthEvents);
          return monthEvents;
        } catch (error) {
          console.error(`Failed to refresh events for ${month}, using cached data:`, error);
          // Return stale data if available (graceful degradation)
          if (data) {
            return data;
          }
          throw error;
        }
      }
    }
    
    // Fetch all pages for this month
    const monthEvents = await fetchMonthEvents(domain, websiteId, month, baseUrl);
    
    // Cache the month's events
    await cacheMonthEvents(env, domain, month, monthEvents);
    
    return monthEvents;
  });
  
  // Wait for all months to complete
  const monthResults = await Promise.all(monthPromises);
  
  // Flatten all events into a single array
  const allEvents = monthResults.flat();
  
  // Sort events by start time
  allEvents.sort((a, b) => {
    const dateA = new Date(a.startDate || a.start_date || a.start_time);
    const dateB = new Date(b.startDate || b.start_date || b.start_time);
    return dateA - dateB;
  });
  
  // Enhance events with full descriptions from Subsplash API
  const enhancedEvents = await enhanceEventsWithDescriptions(allEvents, domain, env);
  
  return enhancedEvents;
}

async function fetchMonthEvents(domain, websiteId, month, baseUrl, maxEvents = null) {
  const monthEvents = [];
  let page = 1;
  let hasMore = true;
  
  console.log(`Fetching events for ${month}, websiteId: ${websiteId}`);
  
  // Fetch all pages for this month
  while (hasMore) {
    const events = await fetchSubsplashEventsPage(domain, websiteId, month, page);
    
    if (events.length === 0) {
      hasMore = false;
    } else {
      // Process events to convert relative URLs to absolute and extract timezone
      const processedEvents = events.map(event => {
        // Convert relative URLs to absolute
        if (event.url && !event.url.startsWith('http')) {
          event.url = baseUrl + (event.url.startsWith('/') ? '' : '/') + event.url;
        }
        if (event.link && !event.link.startsWith('http')) {
          event.link = baseUrl + (event.link.startsWith('/') ? '' : '/') + event.link;
        }
        if (event.event_url && !event.event_url.startsWith('http')) {
          event.event_url = baseUrl + (event.event_url.startsWith('/') ? '' : '/') + event.event_url;
        }
        
        // Extract timezone from various possible fields
        if (!event.timezone) {
          event.timezone = event.time_zone || event.tz || event.timeZone || event.event_timezone;
        }
        
        return event;
      });
      
      monthEvents.push(...processedEvents);
      
      // If we have a max limit and we've reached it, stop
      if (maxEvents && monthEvents.length >= maxEvents) {
        hasMore = false;
        break;
      }
      
      // If we got less than 50 events, we've reached the last page
      if (events.length < 50) {
        hasMore = false;
      } else {
        page++;
      }
    }
  }
  
  // Return the trimmed array if we have a limit
  if (maxEvents && monthEvents.length > maxEvents) {
    return monthEvents.slice(0, maxEvents);
  }
  
  return monthEvents;
}

async function cacheMonthEvents(env, domain, month, monthEvents) {
  if (!env || !env.SUBSPLASH_ICAL || !monthEvents || monthEvents.length === 0) {
    return;
  }
  
  const cacheKey = `events:${domain}:${month}:v${CACHE_VERSION}`;
  
  // Calculate soft expiration based on how far in the future the month is
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthNum = now.getMonth() + 1;
  
  // Parse the month string (YYYY-MM)
  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr);
  const monthNum = parseInt(monthStr);
  
  // Calculate months from now
  const monthsFromNow = (year - currentYear) * 12 + (monthNum - currentMonthNum);
  
  // Gradual refresh intervals:
  // Current month: 1 hour
  // Next month: 2 hours
  // 2 months out: 4 hours
  // 3 months out: 8 hours
  // 4-6 months out: 12 hours
  // 7-12 months out: 24 hours
  let refreshInterval;
  if (monthsFromNow <= 0) {
    refreshInterval = 3600; // 1 hour for current and past months
  } else if (monthsFromNow === 1) {
    refreshInterval = 7200; // 2 hours
  } else if (monthsFromNow === 2) {
    refreshInterval = 14400; // 4 hours
  } else if (monthsFromNow === 3) {
    refreshInterval = 28800; // 8 hours
  } else if (monthsFromNow <= 6) {
    refreshInterval = 43200; // 12 hours
  } else {
    refreshInterval = 86400; // 24 hours
  }
  
  // Add some randomness to prevent cache stampede (±10%)
  const jitter = Math.floor(refreshInterval * 0.1 * (Math.random() * 2 - 1));
  refreshInterval = refreshInterval + jitter;
  
  // Calculate when data should be refreshed
  const refreshAfter = Date.now() + (refreshInterval * 1000);
  
  // Store with metadata
  const cacheData = {
    data: monthEvents,
    metadata: {
      refreshAfter,
      cachedAt: Date.now(),
      month,
      domain
    }
  };
  
  // Keep cached data for 7 days (604800 seconds) for resilience
  await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify(cacheData), {
    expirationTtl: 604800 // 7 days hard expiration
  });
}

async function fetchSubsplashEventsPage(domain, websiteId, month, page = 1) {
  const apiUrl = 'https://site.snappages.site/controllers/events';
  
  const params = new URLSearchParams({
    'action': 'getEvents',
    'website_id': websiteId,
    'page': page.toString(),
    'date': month,
    'embed': 'false'
  });
  
  try {
    const response = await fetch(`${apiUrl}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)',
        'Referer': domain.includes('.') ? `https://${domain}/events` : `https://${domain}.snappages.site/events`
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch events for ${month} page ${page}: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    // Debug: Log the entire API response structure
    console.log(`API Response for ${month} page ${page}:`, {
      hasEvents: !!data.events,
      hasData: !!data.data,
      hasItems: !!data.items,
      topLevelKeys: Object.keys(data),
      dataType: typeof data
    });
    
    // Extract events from the response
    // The structure might vary, so we check multiple possible paths
    const events = data.events || data.data || data.items || [];
    
    // Validate that we got an array
    if (!Array.isArray(events)) {
      console.error('API response does not contain an array of events:', data);
      return [];
    }
    
    // Debug: Log first event to see structure and look for timezone data
    if (events.length > 0) {
      const firstEvent = events[0];
      console.log('Sample event structure from API:', JSON.stringify(firstEvent, null, 2));
      console.log('All available fields in first event:', Object.keys(firstEvent));
      
      // Check various possible timezone field names
      const timezoneFields = ['time_zone', 'timezone', 'tz', 'timeZone', 'event_timezone'];
      timezoneFields.forEach(field => {
        if (firstEvent[field]) {
          console.log(`Found timezone in field '${field}':`, firstEvent[field]);
        }
      });
    }
    
    // Validate event structure
    if (events.length > 0) {
      const sampleEvent = events[0];
      const requiredFields = ['title', 'name', 'event_name'];
      const hasTitle = requiredFields.some(field => sampleEvent[field]);
      
      if (!hasTitle) {
        console.warn('Events may have unexpected structure - no recognizable title field found');
      }
    }
    
    return events;
  } catch (error) {
    console.error(`Error fetching events for ${month} page ${page}:`, error);
    return [];
  }
}

function generateTimezoneDefinition(timezone) {
  const timezoneDefinitions = {
    'America/New_York': [
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZNAME:EST',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZNAME:EDT',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'END:DAYLIGHT',
      'END:VTIMEZONE'
    ],
    'America/Chicago': [
      'BEGIN:VTIMEZONE',
      'TZID:America/Chicago',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZNAME:CST',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0600',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZNAME:CDT',
      'TZOFFSETFROM:-0600',
      'TZOFFSETTO:-0500',
      'END:DAYLIGHT',
      'END:VTIMEZONE'
    ],
    'America/Denver': [
      'BEGIN:VTIMEZONE',
      'TZID:America/Denver',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZNAME:MST',
      'TZOFFSETFROM:-0600',
      'TZOFFSETTO:-0700',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZNAME:MDT',
      'TZOFFSETFROM:-0700',
      'TZOFFSETTO:-0600',
      'END:DAYLIGHT',
      'END:VTIMEZONE'
    ],
    'America/Los_Angeles': [
      'BEGIN:VTIMEZONE',
      'TZID:America/Los_Angeles',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZNAME:PST',
      'TZOFFSETFROM:-0700',
      'TZOFFSETTO:-0800',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZNAME:PDT',
      'TZOFFSETFROM:-0800',
      'TZOFFSETTO:-0700',
      'END:DAYLIGHT',
      'END:VTIMEZONE'
    ]
  };
  
  return timezoneDefinitions[timezone] || timezoneDefinitions['America/New_York'];
}

function generateICal(events, domain, calendarName = null) {
  // Extract a clean name from the domain
  const siteName = domain.split('.')[0];
  const calendarDisplayName = calendarName 
    ? `${siteName} - ${calendarName}`
    : `${siteName} Events (All Calendars)`;
    
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//Subsplash//subsplash.com',
    `X-WR-CALNAME:${calendarDisplayName}`
  ];
  
  // Detect timezone from events or infer from domain
  const timezonesUsed = new Set();
  let detectedTimezone = null;
  
  events.forEach(event => {
    if (event.timezone) {
      timezonesUsed.add(event.timezone);
      detectedTimezone = event.timezone;
    }
  });
  
  // If no timezone in events, log warning and use fallback
  if (!detectedTimezone) {
    console.warn(`No timezone data found in events for ${domain}, using America/New_York as fallback`);
    detectedTimezone = 'America/New_York'; // Default fallback
    timezonesUsed.add(detectedTimezone);
  } else {
    console.log(`Detected timezone for ${domain}: ${detectedTimezone} from event data`);
  }
  
  // Add timezone definitions for detected timezones
  timezonesUsed.forEach(timezone => {
    lines.push(...generateTimezoneDefinition(timezone));
  });
  
  // Add each event
  events.forEach(event => {
    lines.push('BEGIN:VEVENT');
    
    // Generate unique ID
    const eventId = event.id || event.event_id || `${Date.now()}-${Math.random()}`;
    const uid = `${eventId}@${domain}`;
    lines.push(`UID:${uid}`);
    
    // Extract dates - handle various field names
    const startDate = event.start || event.startDate || event.start_date || event.start_time || event.date;
    const endDate = event.end || event.endDate || event.end_date || event.end_time;
    const isAllDay = event.allDay || event.all_day || false;
    
    // Add timestamps with timezone support
    const timezone = event.timezone || detectedTimezone;
    
    if (startDate) {
      if (isAllDay) {
        const dtStart = formatDateToICal(startDate, true);
        lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
      } else {
        const dtStart = formatDateToICalWithTimezone(startDate, timezone);
        lines.push(`DTSTART;TZID=${timezone}:${dtStart}`);
      }
    }
    
    if (endDate) {
      if (isAllDay) {
        const dtEnd = formatDateToICal(endDate, true);
        lines.push(`DTEND;VALUE=DATE:${dtEnd}`);
      } else {
        const dtEnd = formatDateToICalWithTimezone(endDate, timezone);
        lines.push(`DTEND;TZID=${timezone}:${dtEnd}`);
      }
    } else if (startDate && !isAllDay) {
      // If no end time, assume 1 hour duration
      const start = new Date(startDate);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const dtEnd = formatDateToICalWithTimezone(end, timezone);
      lines.push(`DTEND;TZID=${timezone}:${dtEnd}`);
    }
    
    // Add event title with calendar name if showing all calendars
    let title = event.title || event.name || event.event_name || 'Untitled Event';
    
    // Get the calendar name for this event
    const eventCalendarName = event.calendar ||
                             event.calendar_name || 
                             event.calendarName || 
                             event.calendar?.name ||
                             event.calendar?.title ||
                             event.category ||
                             event.categoryName ||
                             event.category_name ||
                             null;
    
    // Add calendar name to title if we're showing all calendars (use full name, not normalized)
    if (!calendarName && eventCalendarName) {
      // Trim " Calendar" from the end of the calendar name for cleaner display
      const cleanCalendarName = eventCalendarName.replace(/ Calendar$/i, '');
      title = `${title} (${cleanCalendarName})`;
    }
    
    lines.push(`SUMMARY:${escapeICalText(title)}`);
    
    // Build description in Subsplash style
    let description = '';
    
    // Use enhanced description from Subsplash API if available, otherwise fall back to basic fields
    if (event.description || event.summary || event.details) {
      // Prefer HTML description from API, then text description, then basic fields
      description = event.description || event.description_text || event.summary || event.details || '';
    }
    
    // Add "Full details available at:" footer like Subsplash
    const eventUrl = event.url || event.link || event.event_url;
    if (eventUrl) {
      const fullUrl = eventUrl.startsWith('http') ? eventUrl : `https://${domain}${eventUrl}`;
      // Ensure proper spacing before the link
      if (description && description.trim()) {
        // Add double line break for clear separation
        description = description.trim() + '\n\nFull details available at: ' + fullUrl;
      } else {
        description = 'Full details available at: ' + fullUrl;
      }
    }
    
    if (description.trim()) {
      lines.push(`DESCRIPTION:${escapeICalText(description)}`);
    }
    
    // Add location
    const location = event.location || event.venue || event.address;
    if (location) {
      let locationText = '';
      if (typeof location === 'string') {
        locationText = location;
      } else if (location.name || location.address) {
        locationText = [location.name, location.address].filter(Boolean).join(', ');
      }
      if (locationText.trim()) {
        lines.push(`LOCATION:${escapeICalText(locationText)}`);
      }
    }
    
    // URL is now included in description as "Full details available at:" footer
    
    // Add creation/modification times
    const now = formatDateToICal(new Date());
    lines.push(`DTSTAMP:${now}`);
    
    if (event.created_at || event.createdAt) {
      lines.push(`CREATED:${formatDateToICal(event.created_at || event.createdAt)}`);
    }
    
    if (event.updated_at || event.updatedAt || event.modified_at) {
      lines.push(`LAST-MODIFIED:${formatDateToICal(event.updated_at || event.updatedAt || event.modified_at)}`);
    }
    
    // Add categories if available
    const categories = event.categories || event.tags || event.category;
    if (categories) {
      let categoryList = [];
      if (Array.isArray(categories)) {
        categoryList = categories;
      } else if (typeof categories === 'string') {
        categoryList = [categories];
      }
      if (categoryList.length > 0) {
        lines.push(`CATEGORIES:${categoryList.map(c => escapeICalText(c.toString())).join(',')}`);
      }
    }
    
    lines.push('END:VEVENT');
  });
  
  lines.push('END:VCALENDAR');
  
  // Apply line folding for ICS/iCal compatibility (75 character max)
  const foldedLines = [];
  lines.forEach(line => {
    if (line.length <= 75) {
      foldedLines.push(line);
    } else {
      // Fold long lines
      let remaining = line;
      while (remaining.length > 75) {
        foldedLines.push(remaining.substring(0, 75));
        remaining = ' ' + remaining.substring(75); // Continue with space prefix
      }
      if (remaining.length > 0) {
        foldedLines.push(remaining);
      }
    }
  });
  
  return foldedLines.join('\r\n');
}

function formatDateToICal(date, allDay = false) {
  const d = new Date(date);
  
  if (allDay) {
    // Format: YYYYMMDD
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }
  
  // Format: YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateToICalWithTimezone(date, timezone) {
  // Parse the date to a Date object
  const d = new Date(date);

  // Check if the date parsing was successful
  if (isNaN(d.getTime())) {
    console.error('Invalid date:', date);
    return '';
  }

  // Use Intl.DateTimeFormat to convert UTC time to the target timezone
  // This properly handles DST and timezone offsets
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(d);
  const partsObj = {};
  parts.forEach(part => {
    partsObj[part.type] = part.value;
  });

  const year = partsObj.year;
  const month = partsObj.month;
  const day = partsObj.day;
  const hour = partsObj.hour;
  const minute = partsObj.minute;
  const second = partsObj.second;

  return `${year}${month}${day}T${hour}${minute}${second}`;
}

// Parse various date formats from Subsplash API
function parseEventDate(dateStr) {
  if (!dateStr) return null;
  
  // Try standard ISO format first
  let date = new Date(dateStr);
  if (!isNaN(date.getTime())) return date;
  
  // Try compact format: YYYYMMDDTHHMMSS
  const compactMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (compactMatch) {
    const [, year, month, day, hour, minute, second] = compactMatch;
    date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    if (!isNaN(date.getTime())) return date;
  }
  
  // Try other common formats
  // YYYY-MM-DD HH:MM:SS
  const dashSpaceMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (dashSpaceMatch) {
    const [, year, month, day, hour, minute, second] = dashSpaceMatch;
    date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    if (!isNaN(date.getTime())) return date;
  }
  
  // If all else fails, try Date constructor one more time
  return new Date(dateStr);
}

function escapeICalText(text) {
  if (!text) return '';
  
  // Clean HTML tags and entities for better Apple Calendar compatibility
  const cleanText = text
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ') // Replace non-breaking spaces
    .replace(/&amp;/g, '&') // Replace HTML entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ') // Normalize spaces (but preserve line breaks)
    .trim();
  
  return cleanText
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Extract short code from event URL (e.g., "x5vjpdn" from "/event/x5vjpdn/july-fellowship-lunch")
function extractShortCode(eventUrl) {
  if (!eventUrl) return null;
  const match = eventUrl.match(/\/event\/([^\/]+)/);
  return match ? match[1] : null;
}

// Get and cache API token from iframe content - fails gracefully
async function getSubsplashApiToken(domain, env) {
  const cacheKey = `subsplash-token:${domain}:v${CACHE_VERSION}`;
  
  try {
    // Check cache first
    if (env.SUBSPLASH_ICAL) {
      const cached = await env.SUBSPLASH_ICAL.get(cacheKey, { type: 'json' });
      if (cached) {
        const { token, expiresAt } = cached;
        // Check if token is still valid (expire 10 minutes before actual expiry)
        if (Date.now() < expiresAt - 600000) {
          return token;
        }
      }
    }
    
    // Try to get first event URL to find iframe
    const siteInfo = await discoverSiteInfo(domain);
    if (!siteInfo) return null;
    
    // Try to fetch events to get a sample event URL
    const sampleEvents = await fetchSubsplashEventsPage(domain, siteInfo.websiteId, new Date().toISOString().slice(0, 7), 1);
    if (!sampleEvents || sampleEvents.length === 0) return null;
    
    const sampleEventUrl = sampleEvents[0].url;
    if (!sampleEventUrl) return null;
    
    // Fetch the event page to get iframe URL
    const eventPageUrl = `${siteInfo.baseUrl}${sampleEventUrl}`;
    const eventPageResponse = await fetch(eventPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)'
      }
    });
    
    if (!eventPageResponse.ok) return null;
    
    const eventPageHtml = await eventPageResponse.text();
    
    // Extract iframe URL
    const iframeMatch = eventPageHtml.match(/src="([^"]*subsplash\.com[^"]*)"/);
    if (!iframeMatch) return null;
    
    const iframeUrl = iframeMatch[1];
    
    // Fetch the iframe content
    const iframeResponse = await fetch(iframeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)'
      }
    });
    
    if (!iframeResponse.ok) return null;
    
    const iframeHtml = await iframeResponse.text();
    
    // Extract the API token from the shoebox
    const tokenMatch = iframeHtml.match(/"apiToken":"([^"]+)"/);
    if (!tokenMatch) return null;
    
    const token = tokenMatch[1];
    
    // Decode JWT to get expiration time
    let expiresAt = Date.now() + 3600000; // Default to 1 hour
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp) {
        expiresAt = payload.exp * 1000; // Convert to milliseconds
      }
    } catch {
      // Use default expiration if JWT decode fails
    }
    
    // Cache the token
    if (env.SUBSPLASH_ICAL) {
      await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify({
        token,
        expiresAt
      }), {
        expirationTtl: Math.max(3600, Math.floor((expiresAt - Date.now()) / 1000))
      });
    }
    
    return token;
    
  } catch (error) {
    console.warn('Could not get Subsplash API token, descriptions will be limited:', error.message);
    return null;
  }
}

// Fetch event details from Subsplash API - fails gracefully
async function fetchSubsplashEventDetails(shortCode, token) {
  if (!shortCode || !token) return null;
  
  try {
    const response = await fetch(`https://core.subsplash.com/events/v2/events?filter%5Bshort_code%5D=${shortCode}&include=location.address%2Cimages%2Cform%2Cform.pricing-strategy`, {
      headers: {
        'accept': 'application/vnd.api+json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'Mozilla/5.0 (compatible; Subsplash-iCal-Worker/2.0)',
        'x-sap-service': 'web-client'
      }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    
    if (!data._embedded || !data._embedded.events || data._embedded.events.length === 0) {
      return null;
    }
    
    const eventDetails = data._embedded.events[0];
    
    // Log timezone data if available
    if (eventDetails.time_zone || eventDetails.timezone) {
      console.log(`Event ${shortCode} has timezone: ${eventDetails.time_zone || eventDetails.timezone}`);
    }
    
    return eventDetails;
    
  } catch (error) {
    console.warn(`Could not fetch event details for ${shortCode}:`, error.message);
    return null;
  }
}

// Calculate cache TTL based on event timing
function calculateEventDetailsCacheTTL(eventDate) {
  const now = new Date();
  const event = new Date(eventDate);
  const diffDays = Math.floor((event - now) / (1000 * 60 * 60 * 24));
  
  if (diffDays <= 7) {
    // Current week: 1 hour
    return 3600;
  } else if (diffDays <= 30) {
    // Current month: 1 day
    return 86400;
  } else if (diffDays <= 90) {
    // Next 3 months: 3 days
    return 259200;
  } else {
    // Beyond 3 months: 1 week
    return 604800;
  }
}

// Cache individual event details with graduated expiration
async function cacheEventDetails(env, domain, shortCode, details) {
  if (!env.SUBSPLASH_ICAL || !details) return;
  
  const cacheKey = `event-details:${domain}:${shortCode}:v${CACHE_VERSION}`;
  const eventDate = details.start_at || details.created_at;
  const ttl = calculateEventDetailsCacheTTL(eventDate);
  
  const cacheData = {
    details,
    cachedAt: Date.now(),
    shortCode,
    domain
  };
  
  await env.SUBSPLASH_ICAL.put(cacheKey, JSON.stringify(cacheData), {
    expirationTtl: ttl
  });
}

// Get cached event details
async function getCachedEventDetails(env, domain, shortCode) {
  if (!env.SUBSPLASH_ICAL) return null;
  
  const cacheKey = `event-details:${domain}:${shortCode}:v${CACHE_VERSION}`;
  const cached = await env.SUBSPLASH_ICAL.get(cacheKey, { type: 'json' });
  
  return cached ? cached.details : null;
}

// Enhance events with full descriptions - aggressive caching with limits
async function enhanceEventsWithDescriptions(events, domain, env) {
  if (!events || events.length === 0) return events;
  
  try {
    // Get API token (this might fail, and that's okay)
    const token = await getSubsplashApiToken(domain, env);
    if (!token) {
      console.log('No API token available, using basic descriptions');
      return events;
    }
    
    // Separate events that need fetching vs those we have cached
    const eventsToFetch = [];
    const enhancedEvents = [];
    
    // Check cache for each event
    for (const event of events) {
      const shortCode = extractShortCode(event.url);
      if (!shortCode) {
        enhancedEvents.push(event);
        continue;
      }
      
      const cachedDetails = await getCachedEventDetails(env, domain, shortCode);
      if (cachedDetails) {
        // Use cached details
        enhancedEvents.push({
          ...event,
          description: cachedDetails.description || event.description,
          description_text: cachedDetails.description_text || event.description_text,
          location: cachedDetails._embedded?.location || event.location,
          timezone: cachedDetails.time_zone || cachedDetails.timezone || event.timezone
        });
      } else {
        // Need to fetch details
        eventsToFetch.push({ event, shortCode });
      }
    }
    
    console.log(`Found ${enhancedEvents.length - eventsToFetch.length} cached event details, need to fetch ${eventsToFetch.length}`);
    
    // Limit to 20 events per request for performance
    const MAX_FETCH_PER_REQUEST = 20;
    const eventsToFetchNow = eventsToFetch.slice(0, MAX_FETCH_PER_REQUEST);
    const eventsToFetchLater = eventsToFetch.slice(MAX_FETCH_PER_REQUEST);
    
    if (eventsToFetchLater.length > 0) {
      console.log(`Deferring ${eventsToFetchLater.length} event details to next sync`);
    }
    
    // Process events in batches to avoid rate limits
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < eventsToFetchNow.length; i += BATCH_SIZE) {
      const batch = eventsToFetchNow.slice(i, i + BATCH_SIZE);
      
      // Create promises for this batch
      const batchPromises = batch.map(async ({ event, shortCode }) => {
        const details = await fetchSubsplashEventDetails(shortCode, token);
        if (!details) {
          return event; // Return original event if details fetch fails
        }
        
        // Cache the details aggressively
        await cacheEventDetails(env, domain, shortCode, details);
        
        // Enhance the event with description data and timezone
        return {
          ...event,
          description: details.description || event.description,
          description_text: details.description_text || event.description_text,
          location: details._embedded?.location || event.location,
          timezone: details.time_zone || details.timezone || event.timezone
        };
      });
      
      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      enhancedEvents.push(...batchResults);
      
      // Small delay between batches to be respectful to API
      if (i + BATCH_SIZE < eventsToFetchNow.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Add events that we deferred (without enhanced details for now)
    for (const { event } of eventsToFetchLater) {
      enhancedEvents.push(event);
    }
    
    console.log(`Enhanced ${eventsToFetchNow.length} events with fresh descriptions, ${enhancedEvents.length - eventsToFetchNow.length} used cache or deferred`);
    return enhancedEvents;
    
  } catch (error) {
    console.warn('Error enhancing events with descriptions:', error.message);
    return events; // Return original events if enhancement fails
  }
}

function serveUI(preloadDomain = null) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Subsplash Calendar Subscription</title>
    <style>
        ${getCSS()}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Subsplash Calendar Subscription</h1>
            <p>Generate ICS/iCal subscription links for Subsplash calendars</p>
        </header>
        <main>
            <div class="info-banner">
                <h3>Why does this service exist?</h3>
                <p>Subsplash currently doesn't provide native ICS/iCal support for their event calendars. While they do offer ICS downloads for individual events, there's no way to subscribe to an entire calendar or category of events. This service bridges that gap by converting Subsplash calendar data into the standard ICS/iCal format, allowing you to subscribe to church and organization calendars in Google Calendar, Apple Calendar, Outlook, and other calendar applications.</p>
            </div>
            <section class="input-section">
                <h2>Enter Your Subsplash Calendar Link</h2>
                <div class="form-group">
                    <input type="text" id="calendarUrl" placeholder="yourchurch.org/events or yourchurch.snappages.site" class="form-input" value="${preloadDomain || ''}">
                    <small>Enter a link to your Subsplash calendar (e.g., your church website with the calendar page)</small>
                </div>
                <div class="button-container">
                    <button id="discoverBtn" class="btn btn-primary">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="search-icon" style="display: inline-block; vertical-align: -3px; margin-right: 6px;">
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="m21 21-4.35-4.35"></path>
                        </svg>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="loading-icon hidden" style="display: inline-block; vertical-align: -3px; margin-right: 6px;">
                            <path d="M21 12a9 9 0 11-6.219-8.56" stroke-linecap="round"></path>
                        </svg>
                        <span class="btn-text">Discover Calendars</span>
                    </button>
                </div>
                <div id="error" class="error hidden"></div>
            </section>
            <section id="results" class="results-section hidden"></section>
        </main>
        <footer>
            <p>This is an unofficial service not affiliated with Subsplash.<br>
            If you encounter issues, please check if Subsplash has added native calendar subscription support.<br>
            Calendar data is cached for performance, refreshing every few hours to couple of days based on event dates.</p>
        </footer>
    </div>
    <script>
        const PRELOAD_DOMAIN = ${preloadDomain ? `'${preloadDomain}'` : 'null'};
        ${getJS()}
    </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

function getCSS() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      line-height: 1.6; 
      color: #e0e0e0; 
      background-color: #1a1a1a; 
      min-height: 100vh;
      background-image: 
        radial-gradient(circle at 20% 50%, rgba(120, 60, 190, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(60, 120, 190, 0.1) 0%, transparent 50%);
    }
    .container { max-width: 900px; margin: 0 auto; padding: 20px; }
    header { 
      text-align: center; 
      margin-bottom: 40px; 
      padding: 40px 20px; 
      background: rgba(255, 255, 255, 0.05); 
      border-radius: 12px; 
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    header h1 { color: #fff; font-size: 2.5em; margin-bottom: 10px; font-weight: 700; }
    header p { color: #b0b0b0; font-size: 1.1em; }
    .info-banner {
      background: rgba(120, 60, 190, 0.1);
      border: 1px solid rgba(120, 60, 190, 0.3);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 30px;
      font-size: 0.95em;
      line-height: 1.7;
    }
    .info-banner h3 { color: #bb86fc; margin-bottom: 10px; }
    .input-section, .results-section { 
      background: rgba(255, 255, 255, 0.05); 
      padding: 30px; 
      border-radius: 12px; 
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      margin-bottom: 20px; 
    }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #fff; }
    .form-input { 
      width: 100%; 
      padding: 12px 16px; 
      border: 1px solid rgba(255, 255, 255, 0.2); 
      border-radius: 8px; 
      font-size: 16px; 
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      transition: all 0.3s ease;
    }
    .form-input:focus { 
      outline: none; 
      border-color: #bb86fc; 
      background: rgba(255, 255, 255, 0.08);
      box-shadow: 0 0 0 3px rgba(187, 134, 252, 0.2);
    }
    .form-input::placeholder { color: rgba(255, 255, 255, 0.4); }
    .form-group small { display: block; margin-top: 5px; color: #999; font-size: 0.9em; }
    .button-container {
      display: flex;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .btn { 
      padding: 12px 30px; 
      border: none; 
      border-radius: 8px; 
      font-size: 16px; 
      font-weight: 600; 
      cursor: pointer; 
      transition: all 0.3s ease; 
    }
    .btn-primary { 
      background: linear-gradient(135deg, #bb86fc 0%, #9c64f7 100%); 
      color: white; 
      box-shadow: 0 4px 15px rgba(187, 134, 252, 0.3);
    }
    .btn-primary:hover { 
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(187, 134, 252, 0.4);
    }
    .btn-primary:disabled { 
      background: #555; 
      cursor: not-allowed; 
      box-shadow: none;
      transform: none;
    }
    .btn-primary.loading .loading-icon {
      animation: spin 1s linear infinite;
    }
    .hidden { display: none !important; }
    .error { 
      color: #ff6b6b; 
      margin-top: 15px; 
      padding: 15px; 
      background-color: rgba(255, 107, 107, 0.1); 
      border: 1px solid rgba(255, 107, 107, 0.3);
      border-radius: 8px; 
    }
    .api-error {
      background: rgba(255, 152, 0, 0.1);
      border: 1px solid rgba(255, 152, 0, 0.3);
      color: #ffb74d;
      padding: 20px;
      border-radius: 8px;
      margin-top: 20px;
    }
    .api-error h3 { margin-bottom: 10px; color: #ff9800; }
    .api-error ul { margin: 10px 0 10px 20px; }
    .loading { 
      color: #bb86fc; 
      text-align: center;
      font-weight: 500;
    }
    .calendar-list { margin-top: 30px; }
    .calendar-item { 
      background: rgba(255, 255, 255, 0.03); 
      border: 1px solid rgba(255, 255, 255, 0.1); 
      border-radius: 12px; 
      padding: 24px; 
      margin-bottom: 16px;
      transition: all 0.3s ease;
    }
    .calendar-item:hover {
      background: rgba(255, 255, 255, 0.05);
      transform: translateY(-2px);
    }
    .calendar-item h3 { color: #fff; margin-bottom: 10px; font-size: 1.3em; }
    .calendar-item .event-count { color: #999; font-size: 0.9em; margin-bottom: 15px; }
    .sample-events {
      margin: 15px 0;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .event-card {
      background: rgba(187, 134, 252, 0.1);
      border: 1px solid rgba(187, 134, 252, 0.2);
      border-radius: 8px;
      padding: 12px;
      flex: 1;
      min-width: 180px;
      max-width: 250px;
      transition: all 0.2s ease;
    }
    .event-card:hover {
      background: rgba(187, 134, 252, 0.15);
      border-color: rgba(187, 134, 252, 0.3);
      transform: translateY(-1px);
    }
    .event-card-title {
      color: #fff;
      font-size: 0.9em;
      font-weight: 500;
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .event-card-date {
      color: #bb86fc;
      font-size: 0.8em;
    }
    .event-card-calendar {
      color: #999;
      font-size: 0.85em;
      font-style: italic;
      margin: 2px 0;
    }
    .sample-label {
      color: #888;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .calendar-links { 
      display: flex; 
      gap: 10px; 
      flex-wrap: wrap; 
      align-items: stretch;
      justify-content: flex-end;
    }
    .download-btn, .copy-btn {
      display: inline-flex; 
      align-items: center; 
      gap: 8px; 
      padding: 10px 20px; 
      color: white; 
      text-decoration: none; 
      border-radius: 8px; 
      font-size: 14px; 
      transition: all 0.3s ease; 
      font-weight: 500;
      border: none;
      cursor: pointer;
      min-height: 40px;
      box-sizing: border-box;
    }
    .download-btn {
      background-color: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .download-btn:hover { 
      background-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.3);
    }
    .download-btn svg, .copy-btn svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .loading-icon, .download-icon {
      position: relative;
    }
    .download-btn:disabled, .download-btn.loading {
      opacity: 0.7;
      cursor: not-allowed;
    }
    .download-btn:disabled:hover {
      transform: none;
      box-shadow: none;
    }
    .download-btn.loading .loading-icon {
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .all-calendars { 
      background: linear-gradient(135deg, rgba(187, 134, 252, 0.2) 0%, rgba(156, 100, 247, 0.2) 100%); 
      padding: 28px; 
      border-radius: 12px; 
      margin-bottom: 30px;
      border: 1px solid rgba(187, 134, 252, 0.3);
    }
    .all-calendars h3 { color: #fff; margin-bottom: 10px; font-size: 1.5em; }
    .all-calendars .event-count { color: rgba(255,255,255,0.8); font-size: 1em; margin-bottom: 15px; }
    .copy-btn { 
      background: linear-gradient(135deg, #bb86fc 0%, #9c64f7 100%);
      border: none;
      font-weight: 600;
    }
    .copy-btn:hover { 
      background: linear-gradient(135deg, #c797fd 0%, #a876f8 100%);
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(187, 134, 252, 0.3);
    }
    .copy-btn.copied { 
      background-color: #4caf50; 
      border-color: #4caf50;
    }
    .subscription-info { 
      margin-top: 20px; 
      padding: 20px; 
      background-color: rgba(66, 165, 245, 0.1); 
      border: 1px solid rgba(66, 165, 245, 0.3);
      border-radius: 8px; 
      font-size: 0.9em; 
      color: #90caf9; 
    }
    .subscription-info strong { color: #64b5f6; }
    footer {
      text-align: center;
      padding: 30px 20px;
      color: #666;
      font-size: 0.85em;
      margin-top: 60px;
    }
    footer a { color: #bb86fc; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  `;
}

function getJS() {
  return `
    
    // Define functions in global scope
    window.handleDownloadClick = function(event, button) {
      // Don't prevent default - we want the download to happen
      // Just add visual feedback
      
      // Disable button and show loading state
      button.disabled = true;
      button.classList.add('loading');
      
      const downloadIcon = button.querySelector('.download-icon');
      const loadingIcon = button.querySelector('.loading-icon');
      const btnText = button.querySelector('.btn-text');
      
      downloadIcon.classList.add('hidden');
      loadingIcon.classList.remove('hidden');
      btnText.textContent = 'Please wait...';
      
      // Re-enable after 26 seconds
      setTimeout(() => {
        button.disabled = false;
        button.classList.remove('loading');
        downloadIcon.classList.remove('hidden');
        loadingIcon.classList.add('hidden');
        btnText.textContent = btnText.textContent.includes('All') ? 'Download All' : 'Download';
      }, 26000);
    }
    
    window.copyToClipboard = function(text, button) {
      navigator.clipboard.writeText(text).then(() => {
        button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
        button.classList.add('copied');
        setTimeout(() => {
          button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy Link to Subscribe';
          button.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy Link to Subscribe';
            button.classList.remove('copied');
          }, 2000);
        } catch (err) {
          alert('Failed to copy. Please copy manually: ' + text);
        }
        document.body.removeChild(textarea);
      });
    }
    
    window.showError = function(message) {
      const errorDiv = document.getElementById('error');
      errorDiv.textContent = message;
      errorDiv.classList.remove('hidden');
    }
    
    window.showApiChangeError = function() {
      const resultsSection = document.getElementById('results');
      resultsSection.innerHTML = \`
        <div class="api-error">
          <h3>⚠️ API Structure Changed</h3>
          <p>It appears that Subsplash has changed their API structure. This service needs to be updated to work with the new format.</p>
          <p><strong>What you can do:</strong></p>
          <ul>
            <li>Check if Subsplash now offers native ICS/iCal support for calendars</li>
            <li>Contact the service maintainer to update the integration</li>
            <li>Try again later in case this is a temporary issue</li>
          </ul>
          <p>This unofficial service relies on Subsplash's internal API structure, which can change without notice.</p>
        </div>
      \`;
      resultsSection.classList.remove('hidden');
    }
    
    window.escapeHtml = function(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Format date for event cards
    function formatEventDate(dateStr, allDay = false) {
      if (!dateStr) return '';
      
      const date = new Date(dateStr);
      const options = {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      };
      
      if (!allDay) {
        options.hour = 'numeric';
        options.minute = '2-digit';
      }
      
      return date.toLocaleDateString('en-US', options);
    }
    
    // Generate event cards HTML
    function generateEventCards(events, totalCount, showCalendarName = false) {
      if (!events || events.length === 0) return '';
      
      // Create header with total count
      let headerText;
      if (totalCount === 1) {
        headerText = 'Contains 1 event';
      } else if (events.length < totalCount) {
        headerText = \`Contains \${totalCount} events such as…\`;
      } else {
        headerText = \`Contains \${totalCount} events\`;
      }
      
      let html = \`<div class="sample-label">\${headerText}</div>\`;
      html += '<div class="sample-events">';
      
      events.forEach(event => {
        const title = escapeHtml(event.title);
        const date = formatEventDate(event.start, event.allDay);
        const calendarName = event.calendar || '';
        
        html += \`
          <div class="event-card">
            <div class="event-card-title" title="\${title}">\${title}</div>
            \${showCalendarName && calendarName ? \`<div class="event-card-calendar">\${escapeHtml(calendarName)}</div>\` : ''}
            <div class="event-card-date">\${date}</div>
          </div>
        \`;
      });
      
      html += '</div>';
      
      return html;
    }

    // Wait for DOM to be ready
    function initializeApp() {
      const discoverBtn = document.getElementById('discoverBtn');
      
      if (!discoverBtn) {
        return;
      }
      
      // Set focus to the input field
      const calendarInput = document.getElementById('calendarUrl');
      if (calendarInput) {
        calendarInput.focus();
      }
      
      // If we have a preloaded domain, auto-discover
      if (PRELOAD_DOMAIN) {
        setTimeout(() => {
          discoverBtn.click();
        }, 100);
      }
      
      discoverBtn.addEventListener('click', async function() {
      const calendarUrl = document.getElementById('calendarUrl').value.trim();
      const btn = this;
      const resultsSection = document.getElementById('results');
      const loadingDiv = document.getElementById('loading');
      const errorDiv = document.getElementById('error');
      
      // Reset UI
      errorDiv.classList.add('hidden');
      resultsSection.classList.add('hidden');
      
      if (!calendarUrl) {
        showError('Please enter a link to your Subsplash calendar');
        return;
      }
      
      // Normalize and validate URL
      let normalizedUrl = calendarUrl.trim();
      
      // Add https:// if no protocol specified
      if (!normalizedUrl.match(/^https?:\\/\\//)) {
        normalizedUrl = 'https://' + normalizedUrl;
      }
      
      // Add .snappages.site if just a subdomain
      if (!normalizedUrl.includes('.') || normalizedUrl.match(/^https?:\\/\\/[^.\\/]+$/)) {
        normalizedUrl = normalizedUrl + '.snappages.site';
      }
      
      try {
        const url = new URL(normalizedUrl);
        // Accept any valid URL - we'll check for Subsplash content later
        // Update the input with normalized URL for clarity
        document.getElementById('calendarUrl').value = normalizedUrl;
      } catch (e) {
        showError('Please enter a valid URL (e.g., "yourchurch.org/events" or "yourchurch.snappages.site")');
        return;
      }
      
      // Disable button and show loading state
      btn.disabled = true;
      btn.classList.add('loading');
      
      // Update button content
      const searchIcon = btn.querySelector('.search-icon');
      const loadingIcon = btn.querySelector('.loading-icon');
      const btnText = btn.querySelector('.btn-text');
      
      if (searchIcon) searchIcon.classList.add('hidden');
      if (loadingIcon) loadingIcon.classList.remove('hidden');
      if (btnText) btnText.textContent = 'Discovering Calendars...';
      
      try {
        // Discover calendars with cache-busting
        const response = await fetch('/api/discover?url=' + encodeURIComponent(normalizedUrl) + '&_=' + Date.now(), {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });
        const data = await response.json();
        
        if (!response.ok) {
          if (response.status === 404 && data.message) {
            // Show the helpful message from the server
            throw new Error(data.message);
          } else if (response.status === 404) {
            throw new Error('Unable to find Subsplash calendar data. Make sure the site has a Subsplash calendar (either directly or embedded in an iframe).');
          }
          throw new Error(data.error || 'Failed to discover calendars');
        }
        
        // Check for redirect response
        if (data.redirect && data.suggestedUrl) {
          showError(data.message + ' Try using: ' + data.suggestedUrl);
          return;
        }
        
        // Check if no events were found (but response was OK)
        if (data.totalEvents === 0) {
          showError(data.message || 'No calendar events found at this URL. Please provide a URL to a page that displays a Subsplash calendar.');
          return;
        }
        
        // Validate API response structure
        if (!data.calendars || !Array.isArray(data.calendars)) {
          showApiChangeError();
          return;
        }
        
        // Generate results HTML
        const workerUrl = window.location.origin;
        let html = '<h2>Available Calendar Subscriptions</h2>';
        
        // All calendars option
        html += \`
          <div class="all-calendars">
            <h3>All Calendars Combined</h3>
            \${data.sampleEvents ? generateEventCards(data.sampleEvents, data.totalEvents, true) : ''}
            <div class="calendar-links">
              <a href="\${workerUrl}/\${data.domain}.ics" class="btn download-btn" download onclick="handleDownloadClick(event, this)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="download-icon">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="loading-icon hidden">
                  <path d="M21 12a9 9 0 11-6.219-8.56" stroke-linecap="round"></path>
                </svg>
                <span class="btn-text">Download All</span>
              </a>
              <button class="copy-btn" onclick="copyToClipboard('\${workerUrl}/\${data.domain}.ics', this)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Link to Subscribe
              </button>
            </div>
          </div>
        \`;
        
        // Individual calendars
        if (data.calendars.length > 0) {
          html += '<div class="calendar-list">';
          html += '<h3>Individual Calendars</h3>';
          
          data.calendars.forEach(calendar => {
            const calendarUrl = \`\${workerUrl}/\${data.domain}/\${calendar.normalized}.ics\`;
            html += \`
              <div class="calendar-item">
                <h3>\${escapeHtml(calendar.name)}</h3>
                \${calendar.sampleEvents ? generateEventCards(calendar.sampleEvents, calendar.eventCount) : ''}
                <div class="calendar-links">
                  <a href="\${calendarUrl}" class="btn download-btn" download onclick="handleDownloadClick(event, this)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="download-icon">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="loading-icon hidden">
                      <path d="M21 12a9 9 0 11-6.219-8.56" stroke-linecap="round"></path>
                    </svg>
                    <span class="btn-text">Download</span>
                  </a>
                  <button class="copy-btn" onclick="copyToClipboard('\${calendarUrl}', this)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy Link to Subscribe
                  </button>
                </div>
              </div>
            \`;
          });
          
          html += '</div>';
        }
        
        html += \`
          <div class="subscription-info">
            <strong>How to subscribe:</strong>
            <ul style="margin-top: 10px; padding-left: 20px;">
              <li><strong>Copy Link to Subscribe</strong> - For ongoing sync with Google Calendar, Outlook, or other calendar apps. Paste the URL into your calendar app's "Add Calendar by URL" feature</li>
              <li><strong>Download</strong> - For a one-time import of current events (won't automatically update and may be incomplete)</li>
            </ul>
          </div>
        \`;
        
        resultsSection.innerHTML = html;
        resultsSection.classList.remove('hidden');
        
        // Update URL to make it shareable
        const newUrl = '/' + data.domain;
        window.history.pushState({ domain: data.domain }, '', newUrl);
        
        // Scroll to results
        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        
      } catch (error) {
        showError(error.message || 'An error occurred while discovering calendars');
      } finally {
        // Restore button state
        btn.disabled = false;
        btn.classList.remove('loading');
        
        const searchIcon = btn.querySelector('.search-icon');
        const loadingIcon = btn.querySelector('.loading-icon');
        const btnText = btn.querySelector('.btn-text');
        
        if (searchIcon) searchIcon.classList.remove('hidden');
        if (loadingIcon) loadingIcon.classList.add('hidden');
        if (btnText) btnText.textContent = 'Discover Calendars';
      }
      });
      
      // Allow Enter key to submit
      document.getElementById('calendarUrl').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          document.getElementById('discoverBtn').click();
        }
      });
      
    }
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
      // DOM is already ready
      initializeApp();
    }
  `;
}