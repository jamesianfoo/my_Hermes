# Home Inspection Lead Qualifier

Typeform → Claude scoring → outbound Twilio call → Cal.com booking → Google Sheets log.

## Run

```bash
npm install
cp .env.example .env   # fill it in
npm start
```

Listens on `0.0.0.0:$PORT` (default 3000). `SERVER_URL` must be a public HTTPS URL Twilio can
reach — Twilio fetches both the TwiML and the ElevenLabs mp3s from it.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | `{"status":"ok","timestamp":"<ISO>"}` |
| `POST /webhook/typeform` | Typeform submission → score → call → log |
| `POST /voice/start` | Greet, ask "how can I help you?" |
| `POST /voice/problem` | Store the problem, ask for a preferred day/time |
| `POST /voice/schedule` | Check Cal.com, offer the closest slot |
| `POST /voice/confirm` | Book it and confirm by voice |
| `POST /voice/status` | Twilio status callback |
| `GET /audio/:file` | Generated ElevenLabs mp3s |

## Flow

1. Typeform posts a submission. The `Typeform-Signature` header is verified against
   `TYPEFORM_SECRET` (skipped, with a warning, if that var is unset). Then `name`, `phone`, `email`, `serviceNeeded`, and `problem` are matched
   by field ref, id, or title (a flat JSON body with those keys also works, for testing).
2. `leadScorer` asks Claude for `score`, `tier`, `urgency`, `estJobValue`, `keySignals`, and
   `followUpNote`. Tier is recomputed from the score (8-10 Hot / 5-7 Warm / 1-4 Cold) so the two
   can never disagree. If Claude is unavailable the lead falls back to Warm rather than being dropped.
3. Hot or Warm **and** a phone number present → outbound Twilio call to `SERVER_URL/voice/start`
   with `statusCallback` `SERVER_URL/voice/status`. Hot also texts the owner.
4. The call runs the four `<Gather>` steps above. Prompts are spoken with ElevenLabs
   (`eleven_turbo_v2`) rendered to `src/audio` and `<Play>`ed; if ElevenLabs fails or times out
   (`ELEVEN_TIMEOUT_MS`, default 8s) the same text goes out via Twilio `<Say>`. mp3s are cached
   by content hash, so repeated prompts cost one synthesis.
5. Every lead is appended to Google Sheets across the 15 columns; the `Inspection Booked` cell is
   flipped to `Yes` in place when the call books.

## Failure behaviour

Every degradation path keeps the call alive and the lead recorded:

| Failure | Behaviour |
| --- | --- |
| ElevenLabs slow or erroring | Same text spoken via Twilio `<Say>` |
| No Cal.com availability | Polite hangup; lead noted "needs manual callback" |
| Cal.com booking rejected | Caller told the office will confirm; row flagged "BOOK MANUALLY" |
| Any handler throws | Apology + hangup, lead written to the sheet with the error |
| Call drops mid-flow | `/voice/status` writes the lead on any terminal call status |
| Sheets slow | Writes bounded at 5s so TwiML never exceeds Twilio's timeout |

`src/audio` is created at startup (`recursive: true`) since Git does not track empty
directories, and the Google private key is un-escaped with `.replace(/\\n/g, "\n")` so a
single-line `.env` value still parses.

## Notes

- All times spoken to the caller and the Cal.com attendee `timeZone` come from `TIMEZONE`.
  Nothing is hardcoded.
- Call state is an in-memory `Map` keyed by `CallSid`. Move it to Redis before running more than
  one process.
- Cal.com booking errors log `err.response.status` and the full response body.
