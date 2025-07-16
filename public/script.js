document.addEventListener('DOMContentLoaded', function() {
    const generateBtn = document.getElementById('generateBtn');
    const resultsSection = document.getElementById('results');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const copyBtns = document.querySelectorAll('.copy-btn');

    generateBtn.addEventListener('click', generateLinks);
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            switchTab(this.dataset.tab);
        });
    });

    copyBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            copyToClipboard(this.dataset.target);
        });
    });

    function generateLinks() {
        const calendarUrl = document.getElementById('calendarUrl').value.trim();
        const workerUrl = document.getElementById('workerUrl').value.trim();
        const calendarId = document.getElementById('calendarId').value.trim();

        if (!calendarUrl || !workerUrl) {
            alert('Please enter both your Subsplash calendar URL and Worker URL');
            return;
        }

        // Extract domain from calendar URL
        let domain;
        try {
            const url = new URL(calendarUrl);
            domain = url.hostname.split('.')[0];
        } catch (e) {
            alert('Invalid calendar URL. Please enter a valid URL.');
            return;
        }

        // Generate subscription link
        let subscriptionLink = `${workerUrl}/?domain=${domain}`;
        if (calendarId) {
            subscriptionLink += `&calendar_id=${calendarId}`;
        }

        // Update links
        document.getElementById('subscriptionLink').value = subscriptionLink;
        
        // Google Calendar link
        const googleLink = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(subscriptionLink)}`;
        document.getElementById('googleLink').href = googleLink;

        // Outlook link
        const outlookLink = `https://outlook.live.com/calendar/0/addcalendar?url=${encodeURIComponent(subscriptionLink)}&name=${encodeURIComponent(domain + ' Calendar')}`;
        document.getElementById('outlookLink').href = outlookLink;

        // Generate embed code
        generateEmbedCode(subscriptionLink, domain);

        // Generate instructions
        generateInstructions(subscriptionLink, domain);

        // Show results
        resultsSection.classList.remove('hidden');
        resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

    function generateEmbedCode(subscriptionLink, domain) {
        // Create button preview
        const buttonPreview = document.getElementById('buttonPreview');
        buttonPreview.innerHTML = `
            <div class="calendar-subscribe-widget">
                <button class="subscribe-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" style="margin-right: 8px;">
                        <path fill="currentColor" d="M19,3H18V1H16V3H8V1H6V3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V8H19V19M12,10H17V15H12V10Z"/>
                    </svg>
                    Subscribe to Calendar
                </button>
            </div>
        `;

        // HTML code
        const htmlCode = `<!-- Subsplash Calendar Subscribe Button -->
<div class="calendar-subscribe-widget">
    <button onclick="subscribeToCalendar()" style="
        background-color: #4CAF50;
        color: white;
        border: none;
        padding: 12px 24px;
        font-size: 16px;
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
        <svg width="20" height="20" viewBox="0 0 24 24" style="margin-right: 8px;">
            <path fill="currentColor" d="M19,3H18V1H16V3H8V1H6V3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V8H19V19M12,10H17V15H12V10Z"/>
        </svg>
        Subscribe to Calendar
    </button>
</div>

<script>
function subscribeToCalendar() {
    const calendarUrl = '${subscriptionLink}';
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMac = /Macintosh/.test(navigator.userAgent);
    
    if (isIOS || isMac) {
        // For iOS/Mac, use webcal protocol
        window.location.href = calendarUrl.replace('https://', 'webcal://');
    } else {
        // For others, show instructions
        const message = 'Copy this link and add it to your calendar app:\\n' + calendarUrl;
        if (confirm(message + '\\n\\nOpen Google Calendar to add this subscription?')) {
            window.open('https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(calendarUrl));
        }
    }
}
</script>`;

        // JavaScript widget code
        const jsCode = `<!-- Subsplash Calendar Widget -->
<div id="subsplash-calendar-widget"></div>
<script>
(function() {
    const config = {
        subscriptionUrl: '${subscriptionLink}',
        buttonText: 'Subscribe to Calendar',
        buttonColor: '#4CAF50',
        textColor: '#ffffff'
    };

    const widget = document.getElementById('subsplash-calendar-widget');
    
    const styles = \`
        .subsplash-cal-widget {
            display: inline-block;
            margin: 10px 0;
        }
        .subsplash-cal-btn {
            background-color: \${config.buttonColor};
            color: \${config.textColor};
            border: none;
            padding: 12px 24px;
            font-size: 16px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            transition: opacity 0.2s;
        }
        .subsplash-cal-btn:hover {
            opacity: 0.9;
        }
        .subsplash-cal-dropdown {
            position: absolute;
            background: white;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 10px;
            margin-top: 5px;
            display: none;
            z-index: 1000;
            min-width: 200px;
        }
        .subsplash-cal-dropdown.show {
            display: block;
        }
        .subsplash-cal-link {
            display: block;
            padding: 8px 12px;
            color: #333;
            text-decoration: none;
            border-radius: 3px;
            transition: background-color 0.2s;
        }
        .subsplash-cal-link:hover {
            background-color: #f0f0f0;
        }
    \`;

    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    widget.innerHTML = \`
        <div class="subsplash-cal-widget">
            <button class="subsplash-cal-btn" id="subsplash-cal-btn">
                <svg width="20" height="20" viewBox="0 0 24 24" style="margin-right: 8px;">
                    <path fill="currentColor" d="M19,3H18V1H16V3H8V1H6V3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V8H19V19M12,10H17V15H12V10Z"/>
                </svg>
                \${config.buttonText}
            </button>
            <div class="subsplash-cal-dropdown" id="subsplash-cal-dropdown">
                <a href="https://calendar.google.com/calendar/render?cid=\${encodeURIComponent(config.subscriptionUrl)}" 
                   target="_blank" class="subsplash-cal-link">Google Calendar</a>
                <a href="https://outlook.live.com/calendar/0/addcalendar?url=\${encodeURIComponent(config.subscriptionUrl)}" 
                   target="_blank" class="subsplash-cal-link">Outlook</a>
                <a href="#" onclick="navigator.clipboard.writeText('\${config.subscriptionUrl}'); alert('Calendar link copied!'); return false;" 
                   class="subsplash-cal-link">Copy Link for Apple Calendar</a>
            </div>
        </div>
    \`;

    document.getElementById('subsplash-cal-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById('subsplash-cal-dropdown').classList.toggle('show');
    });

    document.addEventListener('click', function() {
        document.getElementById('subsplash-cal-dropdown').classList.remove('show');
    });
})();
</script>`;

        document.getElementById('htmlCodeText').value = htmlCode;
        document.getElementById('jsCodeText').value = jsCode;
    }

    function generateInstructions(subscriptionLink, domain) {
        const instructions = `Calendar Subscription Instructions for ${domain}

SUBSCRIPTION LINK:
${subscriptionLink}

HOW TO ADD TO YOUR CALENDAR:

Google Calendar (Desktop):
1. Open Google Calendar
2. Click the + next to "Other calendars"
3. Select "From URL"
4. Paste the subscription link
5. Click "Add calendar"

Apple Calendar (Mac):
1. Open Calendar app
2. File → New Calendar Subscription
3. Paste the subscription link
4. Choose update frequency
5. Click OK

Apple Calendar (iPhone/iPad):
1. Go to Settings → Calendar → Accounts
2. Tap "Add Account" → "Other"
3. Tap "Add Subscribed Calendar"
4. Paste the subscription link
5. Tap "Next" and "Save"

Outlook:
1. Go to outlook.com or open Outlook
2. Add calendar → Subscribe from web
3. Paste the subscription link
4. Name your calendar
5. Click "Import"

Note: Calendar will sync automatically based on your app's refresh settings.`;

        document.getElementById('instructionsText').value = instructions;
    }

    function switchTab(tab) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Update code panels
        document.querySelectorAll('.code-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        document.getElementById(tab + 'Code').classList.add('active');
    }

    function copyToClipboard(targetId) {
        const element = document.getElementById(targetId);
        element.select();
        document.execCommand('copy');
        
        // Show feedback
        const btn = document.querySelector(`[data-target="${targetId}"]`);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        
        setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
        }, 2000);
    }
});