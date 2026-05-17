# ChatGPT conversation history rate-limit modal

Last verified: 2026-05-17 KST

This note documents the ChatGPT web modal:

```text
Too many requests

You're making requests too quickly. We've temporarily limited access to your conversations to protect your data.

Please wait a few minutes before trying again.
```

## Short verdict

This modal is a conversation-history rate limit, not the normal model message cap.

The exact modal text is embedded in the ChatGPT web JavaScript bundle. The modal appears when the conversation-history API request returns HTTP `429 Too Many Requests`:

```text
GET /backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false
```

The server decides the threshold. The web bundle only shows what happens after the server returns `429`.

## What was proven

The loaded ChatGPT web bundle contained these static message IDs:

```text
conversationHistoryRateLimitModal.title
conversationHistoryRateLimitModal.bodyLineOne
conversationHistoryRateLimitModal.bodyLineTwo
conversationHistoryRateLimitModal.gotIt
```

The modal DOM uses:

```text
data-testid="modal-conversation-history-rate-limit"
```

The relevant client-side flow in the minified bundle was:

```text
nHt = 429

GET /conversations with:
  offset
  limit: 28
  order: updated
  is_archived: false
  is_starred: false

catch error:
  if error is RequestError and error.status === 429:
    show conversation history rate-limit modal
    return an empty conversation-history page
  else:
    rethrow
```

To avoid actually hammering ChatGPT, the final check used Chrome DevTools Protocol request interception. Only the `backend-api/conversations` request was replaced with a synthetic `429`; the page then rendered the same `modal-conversation-history-rate-limit` DOM and the same screenshot text. That confirms the frontend trigger path.

The 2026-05-17 bundle scan also checked whether the same modal was reused by other history-like endpoints. In the scanned bundle:

```text
modal-conversation-history-rate-limit: 1 occurrence
function RVt: 1 occurrence
nHt=429: 1 occurrence
Gh(xVt): 1 occurrence
safeGet(`/conversations`): 1 occurrence
```

That makes the client-side path narrow: this exact modal is wired to the main `/backend-api/conversations` query's `429` handler. Project and GPT/gizmo sidebar endpoints can add request pressure, but this exact modal is not directly rendered by their client-side error handlers in the scanned bundle.

## What was not proven

The exact server-side threshold was not proven. The bundle does not contain a fixed "N requests per minute" rule for this modal.

Still unknown:

- whether the threshold is per account, session, IP, device, browser profile, workspace, or a weighted mix
- whether the threshold differs for Pro, Team, Enterprise, or temporary service conditions
- whether different endpoints share the same bucket
- the exact cooldown duration

The user-facing "Please wait a few minutes" text is intentionally vague. Treat it as a short server-side cooldown, not a precise timer.

## Live bounded tests from 2026-05-17

After the static bundle check and synthetic `429` check, a bounded live probe was run against the same Oracle manual-login ChatGPT profile:

```text
/Users/pat/.oracle/oracle-live-browser-profile
```

The probe intentionally did not send prompts and did not store response bodies. It recorded only request URLs, methods, status codes, retry-after headers, and whether the modal DOM appeared. Raw artifacts are under:

```text
/Users/pat/oracle/artifacts/chatgpt-history-limit/
```

Three active-capture scripts were used:

```text
/Users/pat/oracle/scripts/chatgpt-history-limit-probe.ts
/Users/pat/oracle/scripts/chatgpt-tab-burst-probe.ts
/Users/pat/oracle/scripts/chatgpt-live-rate-limit-monitor.ts
```

Aggregate result:

```text
probe/monitor runs: 23
total recorded relevant events: 2,237
total recorded responses/probe results: 1,169
conversation-list responses/probe results: 551
status counts: 200=1,059, 401=100, 403=10
429 responses: 0
modal detections: 0
```

The aggregate was rechecked with a structured summarizer so `modalFound:false` cannot be mistaken for a hit just because another field in the same JSON object is `true`:

```bash
cd /Users/pat/oracle
./node_modules/.bin/tsx scripts/chatgpt-history-limit-summarize.ts
```

Key bounded test cases:

| Case                                                    | Result                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| Single ChatGPT home load                                | 17 relevant responses, 1 main `/conversations` response, no `429` |
| Same `/backend-api/conversations?offset=0` every 5s x 8 | all `200`, no modal                                               |
| Same endpoint every 2s x 12                             | all `200`, no modal                                               |
| Same endpoint every 1s x 30                             | all `200`, no modal                                               |
| Sequential offsets `0,28,56...` every 2s x 15           | all `200`, no modal                                               |
| Concurrent sequential-offset burst x 10                 | all `200`, no modal                                               |
| Concurrent sequential-offset burst x 20                 | all `200`, no modal                                               |
| Concurrent sequential-offset burst x 40                 | all `200`, no modal                                               |
| Observed conversation URL mix, concurrent burst x 30    | all `200`, no modal                                               |
| Observed relevant URL mix, concurrent burst x 60        | no `429`; some `401` from non-equivalent fetch context            |
| 3 simultaneous ChatGPT home tabs                        | 45 relevant responses, 18 conversation responses, all `200`       |
| 5 simultaneous ChatGPT home tabs                        | 67 relevant responses, 25 conversation responses, all `200`       |
| 10 simultaneous ChatGPT home tabs                       | 111 relevant responses, 35 conversation responses, no `429`       |
| 20 simultaneous ChatGPT home tabs                       | 314 relevant responses, 120 conversation responses, all `200`     |

Interpretation:

- The frontend condition is still exact: this modal appears when the history query path receives `429`.
- The live threshold is not a simple low fixed limit on `GET /backend-api/conversations`.
- On this account/session at the test time, even 20 simultaneous ChatGPT home tabs and 40 concurrent paginated history requests did not trigger the modal.
- Therefore the earlier popup was probably not caused by a few normal ChatGPT tabs or a small number of repeated history loads by itself.
- More likely remaining causes are a longer rolling server window, mutation-heavy history operations such as delete/archive/unarchive, concurrent Agent/Deep Research task guardrails, account/IP-wide abuse heuristics, or a temporary server-side state that was already hot before the modal appeared.

The important negative finding is that "open a few tabs" is too weak as a standalone explanation. The safer operational explanation is "conversation-history access was throttled by a server-side guard, probably after a broader or longer-lived pattern than the bounded probes reproduced."

## Confidence ladder

High confidence, directly proven:

- This exact modal is a ChatGPT web conversation-history modal.
- The identifying DOM is `data-testid="modal-conversation-history-rate-limit"`.
- The ChatGPT frontend shows it when its main `/backend-api/conversations` query gets HTTP `429`.
- A synthetic `429` on that request reproduces the same modal without sending prompts.
- The 2026-05-17 loaded bundle had one direct modal wiring path for this exact modal.

Medium confidence, supported by local negative tests:

- It is not a normal model-message cap.
- It is not triggered by a small number of prompt submissions; the modal can appear before or aside from message send.
- It is not a low fixed limit like "8 history reads" or "20 tabs once"; those bounded probes did not produce a `429`.
- The real bucket is probably longer-lived and broader than one visible endpoint call.

Lower confidence, still needs a real next-event capture:

- The bucket may weight archive/delete/unarchive mutations.
- The bucket may be shared across ChatGPT Agent, Deep Research, projects, GPT/gizmo history, and normal history.
- The bucket may include account, browser profile, IP, and temporary service pressure.
- The cooldown may be "a few minutes", but no precise value is exposed by the client.

## Current cause model

Use this as the working model until a real `429` capture proves otherwise:

```text
Normal prompts
  -> not the direct trigger

Main conversation-history query
  GET /backend-api/conversations?offset=...&limit=28&order=updated&is_archived=false&is_starred=false
  -> if server returns 429
  -> modal-conversation-history-rate-limit

Project/GPT sidebar queries
  -> do not directly render this modal in the scanned bundle
  -> can still contribute to account/session/IP-level pressure

Oracle browser runs
  -> open ChatGPT home/sidebar
  -> submit a new conversation
  -> sometimes archive successful one-shot conversations
  -> can repeat across multiple sessions
  -> likely contributor only when repeated over a longer window or combined with Deep Research/Agent/history mutation
```

The best hypothesis is therefore not a single tiny per-minute endpoint limit. It is a server-side protection bucket around conversation access. The bucket probably weights more than raw `GET /conversations` count: account state, history scraping shape, archive/delete/unarchive mutations, Agent/Deep Research concurrency, and recent failures may all matter.

Local Oracle evidence supports that shape:

- Oracle defaults to `maxConcurrentTabs: 3`.
- Oracle's `archiveConversations: "auto"` archives successful non-project, non-Deep-Research, one-shot ChatGPT conversations after artifacts are saved.
- The local session logs contained 33 successful ChatGPT auto-archive lines.
- The local session logs also contained several ChatGPT Deep Research runs around 2026-05-15, including runs where the Deep Research iframe appeared but never exposed plan/progress text.

So the more realistic risky pattern is:

```text
several Oracle/ChatGPT browser runs
+ ChatGPT home/sidebar loads
+ conversation creation
+ optional archive mutation
+ Deep Research/Agent start attempts or long-running tasks
+ retries/reattach/reloads
```

That pattern is much closer to public reports and the local history than "20 tabs opened once".

## Exact condition statement

The most precise statement currently supported is:

```text
The popup appears when the ChatGPT web app's conversation-history loader receives
HTTP 429 from the server for the main /backend-api/conversations query.
```

The client-side condition is effectively:

```text
error is RequestError
and error.status === 429
and the failing query is the conversationHistory query backed by /conversations
```

The threshold that makes the server return that `429` is not present in the JavaScript bundle and was not reproduced by bounded low/medium probes. Therefore the exact server threshold remains unproven. The strongest current model is a server-side account/session/IP protection bucket for conversation access, not a simple per-page-load counter.

## Public-source cross-check

As of 2026-05-17 KST, OpenAI does not publish a numeric threshold for this exact modal or for the ChatGPT web `/backend-api/conversations` endpoint.

Official sources support only the broader categories:

- OpenAI 429 guidance says repeated requests after rate-limit errors can make the problem worse: <https://help.openai.com/en/articles/5955604-how-can-i-solve-42> (accessed 2026-05-17)
- ChatGPT Plus documentation says usage limits may vary based on system conditions: <https://help.openai.com/en/articles/6950777-chatgpt-plus> (reported updated 9 hours before the 2026-05-17 source pass)
- ChatGPT Agent documentation says agent use has rate limits, including concurrent-task limits, but publishes no exact count for this modal: <https://help.openai.com/en/articles/11752874-chatgpt-agent> (reported updated 11 days before the 2026-05-17 source pass)
- Deep Research documentation describes plan-specific usage limits and in-product remaining-usage indicators, but not this modal's history endpoint threshold: <https://help.openai.com/en/articles/10500283-deep-research-faq> (reported updated 25 days before the 2026-05-17 source pass)
- Projects documentation does not identify Projects as a direct trigger for this modal: <https://help.openai.com/en/articles/10169521-chatgpt-projects> (reported updated 11 days before the 2026-05-17 source pass)
- ChatGPT Pro documentation says broad access remains subject to abuse guardrails: <https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro/> (accessed 2026-05-17)
- OpenAI Status has had separate incidents involving erroneous rate-limit messages and conversation/history loading, so not every history failure is user-specific rate limiting:
  - <https://status.openai.com/incidents/01JMYB6JXJTH753DHV7Z63F96N> (erroneous rate-limit error messages, 2023-08-01)
  - <https://status.openai.com/incidents/01K4Z91K37SB056633BENWJAT5> (increased rate-limit reports, 2025-09-12)
  - <https://status.openai.com/incidents/vvtggc9m43m8> (chat history failing to load, 2024-08-13)
  - <https://status.openai.com/incidents/01JMYB7876VAPH0YR1HCQ7HN3X> (missing conversation history, 2023-03-09)

Public reverse-engineering and anecdotal reports are consistent with this being a conversation/history-surface guard, especially around bulk history operations and concurrent Agent/Deep Research use, but they do not provide an authoritative numeric threshold.

Additional focused public-source pass on 2026-05-17 found the same boundary:

- No official numeric threshold for this exact web modal.
- Official retention/archive docs describe behavior, not rate-limit coupling.
- Official Agent docs mention rate limits and concurrent task limits, but not this modal's threshold.
- Community reports connect the warning to delete/archive/unarchive cleanup and to about 7 concurrent Agent/Deep Research jobs, but those reports are anecdotal.
- Projects-specific evidence is weak; the stronger evidence points to history/conversation access generally, not Projects as a special case.

## Why Oracle can trigger it

Oracle browser mode opens `chatgpt.com` through Chrome/CDP. Loading the ChatGPT home page or sidebar can fetch the conversation list. Multiple Oracle runs, multiple tabs, and repeated reattach/reload flows can therefore generate many conversation-history requests without sending many prompts.

The ChatGPT web client also refetches conversation history on browser reconnect/window focus in some states. That means tab switching, reopening windows, or many live tabs can contribute.

Likely triggers, ordered after the 2026-05-17 bounded tests:

- deleting, archiving, unarchiving, or otherwise mutating many conversations
- several Agent or Deep Research tasks running concurrently
- repeated Oracle browser runs over a longer rolling window, especially if they create/archive conversations
- multiple browser-mode sessions running at the same time and repeatedly reloading the home/sidebar
- scrolling deep through conversation history for a long account history
- project/sidebar views that fetch additional conversation lists
- several ChatGPT tabs open against the same account/profile, if combined with the patterns above

This explains why the popup can appear even when the model itself is still usable after clicking "Got it". The limited surface is conversation history access.

## How to verify next time

### 1. Check the live DOM

Open ChatGPT with the same browser profile and inspect:

```js
document.querySelector('[data-testid="modal-conversation-history-rate-limit"]')?.innerText;
```

If present, it is this modal.

### 2. Check Network

In DevTools Network, filter for:

```text
backend-api/conversations
```

If that request returns `429`, it matches this finding.

The normal first page request looks like:

```text
/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false
```

### 3. Search current bundles

Asset hashes change, so do not rely on the exact file name from 2026-05-17. Search loaded assets for stable strings:

```bash
curl -L --compressed -sS "https://chatgpt.com/cdn/assets/<current-asset>.js" |
  rg "conversationHistoryRateLimitModal|modal-conversation-history-rate-limit|You're making requests too quickly|temporarily limited access"
```

Useful bundle strings:

```text
conversationHistoryRateLimitModal
modal-conversation-history-rate-limit
Too many requests
You're making requests too quickly
temporarily limited access to your conversations
/conversations
limit:28
status!==nHt
nHt=429
```

There is also a helper script:

```bash
cd /Users/pat/oracle
./node_modules/.bin/tsx scripts/chatgpt-bundle-rate-limit-scan.ts \
  --asset-url https://chatgpt.com/cdn/assets/4813494d-kxjl6bwxgyryk1g4.js
```

Direct `https://chatgpt.com/` asset discovery may fail with `403` from the edge when run as a bare Node fetch. In that case, get the current asset URL from the browser's Network panel and pass it with `--asset-url`.

### 4. Prove the trigger safely with synthetic 429

Do not spam the real endpoint just to reproduce the modal. Intercept only the conversations request and return a fake `429`.

Minimal CDP strategy:

```text
1. Launch Chrome with the same ChatGPT profile.
2. Enable Fetch interception for *://chatgpt.com/backend-api/conversations*
3. Fulfill that paused request with HTTP 429 and a small JSON body.
4. Wait for the page to render.
5. Assert data-testid="modal-conversation-history-rate-limit".
```

Expected DOM result:

```text
modalFound: true
data-testid: modal-conversation-history-rate-limit
text contains:
  Too many requests
  temporarily limited access to your conversations
  Please wait a few minutes
```

### 5. Capture the real next occurrence passively

Use the passive monitor while running normal Oracle/ChatGPT work. It does not navigate, send prompts, or create extra ChatGPT requests; it only attaches to the current Oracle Chrome DevTools port and records relevant response status codes plus the modal DOM state.

```bash
cd /Users/pat/oracle
./node_modules/.bin/tsx scripts/chatgpt-live-rate-limit-monitor.ts \
  --duration-ms 1800000 \
  --poll-ms 1000 \
  --modal-poll-ms 3000
```

If the popup appears during that window, inspect the generated artifact:

```bash
find /Users/pat/oracle/artifacts/chatgpt-history-limit -maxdepth 2 -name summary.json |
  sort |
  tail -1 |
  xargs jq .
```

What to look for:

```text
first429.status == 429
first429.url contains /backend-api/conversations
modalEvents length > 0
endpointCounts for the preceding request mix
```

That is the next high-confidence step. It can tell whether the real event followed a burst of main history reads, project/GPT sidebar reads, archive/delete mutation, or a Deep Research/Agent sequence.

## Operational guidance

When the popup appears:

1. Stop opening new ChatGPT/Oracle browser sessions for a few minutes.
2. Close stale ChatGPT tabs/windows using the same profile.
3. Avoid repeatedly refreshing the ChatGPT home/sidebar.
4. Reattach to existing Oracle sessions instead of starting duplicate runs.
5. If many browser-mode jobs are queued, run them serially or add jitter.
6. If the job does not need history/sidebar, prefer targeting an existing conversation or a narrower URL when the tool supports it.

For Oracle specifically:

```json5
{
  browser: {
    manualLogin: true,
    manualLoginProfileDir: "/Users/pat/.oracle/oracle-live-browser-profile",
    cookieSync: false,
    manualLoginCookieSync: false,
    keepBrowser: false,
    maxConcurrentTabs: 1,
  },
}
```

`maxConcurrentTabs: 1` is conservative. The Oracle default may allow more local tabs, but ChatGPT's server-side history limit is independent of Oracle's local lease system.

## Distinguish from other limits

This modal is not the same as:

- `Messages limit reached` on the composer
- model cap or GPT-5/GPT-5.5 usage quota
- file upload rate-limit banner
- image generation rate limit
- "too many agent tasks in progress"
- Cloudflare/Sentinel bot challenge
- expired login/session token

The identifying signal is the combination of:

```text
conversationHistoryRateLimitModal
modal-conversation-history-rate-limit
GET /backend-api/conversations -> 429
```

## Evidence from 2026-05-17

Current asset that contained the exact modal strings:

```text
https://chatgpt.com/cdn/assets/4813494d-kxjl6bwxgyryk1g4.js
```

Bundle scanner artifact:

```text
/Users/pat/oracle/artifacts/chatgpt-history-limit/2026-05-17T02-05-33-821Z-bundle-scan/summary.json
```

The scanner found:

```text
conversationHistoryRateLimitModal: 4 occurrences
modal-conversation-history-rate-limit: 1 occurrence
temporarily limited access to your conversations: 1 occurrence
/conversations: 4 occurrences
limit:28: 4 occurrences
nHt=429: 1 occurrence
status!==nHt: 1 occurrence
```

Exact component evidence found in that bundle:

```text
testId: modal-conversation-history-rate-limit
title: conversationHistoryRateLimitModal.title
bodyLineOne: conversationHistoryRateLimitModal.bodyLineOne
bodyLineTwo: conversationHistoryRateLimitModal.bodyLineTwo
gotIt: conversationHistoryRateLimitModal.gotIt
```

Exact trigger evidence found in that bundle:

```text
nHt = 429

function RVt(error, offset) {
  if (!(error instanceof RequestError) || error.status !== 429) throw error;
  show modal-conversation-history-rate-limit;
  return empty conversation history page;
}

safeGet('/conversations', {
  query: {
    offset,
    limit: 28,
    order: 'updated',
    is_archived: false,
    is_starred: false
  }
})
```

Synthetic 429 verification:

```text
intercepted:
  https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false

DOM:
  modalFound: true
  data-testid: modal-conversation-history-rate-limit
```

## Practical conclusion

If this popup appears while using Oracle, the fastest mitigation is not changing model settings. Reduce conversation-history fetch pressure:

- one ChatGPT browser run at a time
- fewer open ChatGPT tabs
- fewer home/sidebar reloads
- wait several minutes after the first popup
- reattach instead of rerunning

If it keeps recurring after a quiet period, collect a HAR or CDP log filtered to `backend-api/conversations` and confirm whether the server is still returning `429`.
