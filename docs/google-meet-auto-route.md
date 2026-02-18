# Google Meet -> Command Center Auto Route

This integration routes Gmail "Notes:" emails from Google Meet directly into Command Center as realtime events, then auto-surfaces them in the Unified Inbox.

## 1) What you set once

In Google Apps Script project settings, set Script Properties:

- `CC_INGEST_URL`  
  Example: `https://command-center-sigma-six.vercel.app/api/ingest`
- `CC_INGEST_TOKEN`  
  Your Command Center ingest token.
- `CC_DEFAULT_PROJECT_ID`  
  Example: `outreach-pipeline`
- `CC_GMAIL_QUERY`  
  Example: `subject:"Notes:" newer_than:14d`
- `CC_PROJECT_ROUTES_JSON` (optional keyword routing)  
  Example:
  ```json
  [
    { "projectId": "outreach-pipeline", "keywords": ["outreach", "campaign", "lead"] },
    { "projectId": "polymarket-bot-paper-first", "keywords": ["polymarket", "market", "trade"] }
  ]
  ```

## 2) Apps Script code

Use:
- `/Users/jameshalldon/Documents/Builds/Command Center/scripts/google_meet_gmail_bridge.gs`

Create these triggers in Apps Script:

- `syncGoogleMeetNotesToCommandCenter`: every 1 minute (or every 5 minutes)
- `testGoogleMeetBridgeLatest`: run manually for first validation

## 3) How it works

1. Polls Gmail for messages matching `CC_GMAIL_QUERY`.
2. Picks new "Notes:" emails only.
3. Extracts:
   - meeting title
   - summary
   - suggested next steps
   - notes URL
4. Sends one CloudEvent per email to `/api/ingest` using idempotency key `gmail-meet:<gmailMessageId>`.
5. Command Center UI auto-adds those meeting events into Unified Inbox on the next state poll.

## 4) Verify quickly

1. Run `testGoogleMeetBridgeLatest` in Apps Script.
2. Open Command Center and wait one poll cycle (~45s).
3. In Unified Inbox, confirm a new item:
   - subject starts with `Meeting notes:`
   - source is `google-meet`
   - body includes summary and optional next steps.

## 5) Security notes

- Keep `CC_INGEST_TOKEN` in Script Properties only (never hardcode in file).
- Rotate token if exposed.
- If you use project-scoped ingest keys, ensure routed project IDs match allowed scope.
