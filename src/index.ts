interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Codex Alimentarius maximum residue limits — the internationally agreed legal
 * ceilings for pesticide residues and veterinary drug residues in food, adopted
 * by the FAO/WHO Codex Alimentarius Commission and used as the reference for
 * food trade disputes.
 *
 * Two of Codex's three online databases are covered here. The third — GSFA, the
 * food-additive permissions standard — sits behind a Cloudflare JS challenge and
 * is not reachable from a server at all. See README.
 *
 * Upstream has no documented API; these endpoints back the site's own jQuery
 * pages. Four behaviours will produce wrong answers if trusted:
 *
 *   1. ~10% of pesticide records are INVALID JSON — commodity names contain raw
 *      tab characters inside string literals ("Dry peas \t\t(subgroup)"), which
 *      JSON.parse rejects outright. Everything goes through codexJson().
 *   2. A search that matches nothing returns the search FORM metadata rather
 *      than an empty result, so "no match" and "here is your data" are different
 *      shapes, not an empty list.
 *   3. Unknown ids return HTTP 500, not 404 — so ids are resolved against the
 *      catalog first rather than probed.
 *   4. An empty MRL list is MEANINGFUL: chloramphenicol has zero because Codex
 *      declines to set one for a substance it considers unsafe at any level.
 *      That is the opposite of "no data" and must never be reported as absence.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Codex Alimentarius maximum residue limits');
}

const PEST = 'https://www.fao.org/jsoncodexpest/jsonrequest';
const VETD = 'https://www.fao.org/jsoncodexvetd/jsonrequest';
// A bare bot UA gets a different (HTML) response from this host; send a browser one.
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp-codex-mrl/1.0; +https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'codex_pesticide_search',
    description:
      'Find pesticides in the Codex Alimentarius residue database by name or partial name (glyphosate, chlorpyrifos, 2,4-D). Returns each match with the id needed to fetch its maximum residue limits. Use when you have a pesticide name and want its Codex record.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Pesticide name or fragment, e.g. "glyphosate".' } },
      required: ['query'],
    },
  },
  {
    name: 'codex_pesticide_mrls',
    description:
      'Get the internationally agreed maximum residue limits for one pesticide across every food commodity Codex has set a limit for, plus its Acceptable Daily Intake, the chemical definition of the residue being measured, and its pesticide class. Accepts a pesticide name or a numeric id. Use to answer how much of a pesticide is legally permitted in foods.',
    inputSchema: {
      type: 'object',
      properties: {
        pesticide: { type: 'string', description: 'Pesticide name ("glyphosate") or numeric id ("158").' },
      },
      required: ['pesticide'],
    },
  },
  {
    name: 'codex_commodity_search',
    description:
      'Find food commodities in the Codex pesticide residue database by name (apple, rice, milk, poultry meat). Returns each match with the id needed to look up every pesticide limit that applies to it. Codex splits foods finely — "apple" and "apple pomace, dried" are separate commodities with different limits.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Food or commodity name, e.g. "apple".' } },
      required: ['query'],
    },
  },
  {
    name: 'codex_commodity_mrls',
    description:
      'List every pesticide with a Codex maximum residue limit in one food, with the limit for each. Accepts a commodity id, a Codex commodity code ("FP 0226"), or a food name. Use to answer which pesticide residues are permitted in a given food and at what level.',
    inputSchema: {
      type: 'object',
      properties: {
        commodity: {
          type: 'string',
          description: 'Commodity id ("139"), Codex code ("FP 0226"), or food name ("apple").',
        },
      },
      required: ['commodity'],
    },
  },
  {
    name: 'codex_vetdrug_search',
    description:
      'List or search the veterinary drugs for which Codex has adopted maximum residue limits in animal-derived food — antibiotics, antiparasitics, growth promoters. Omit the query to list all of them with the year each was last adopted.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Drug name or fragment. Omit to list all.' },
      },
    },
  },
  {
    name: 'codex_vetdrug_mrls',
    description:
      'Get the Codex maximum residue limits for one veterinary drug, broken down by animal species and tissue (cattle muscle, liver, kidney, milk; fish fillet; poultry eggs), with its functional class and the JECFA evaluations behind each limit. Accepts a drug name or numeric id. An empty limit list is meaningful — Codex sets no MRL for substances like chloramphenicol that it judges unsafe at any level.',
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: 'Veterinary drug name ("abamectin") or numeric id ("1").' },
      },
      required: ['drug'],
    },
  },
];

// ── Fetching ──────────────────────────────────────────────────────────

/**
 * Escape raw control characters that appear INSIDE string literals.
 *
 * This host hand-templates its JSON, and commodity names carry literal tabs
 * ("Dry peas \t\t(subgroup)"). RFC 8259 requires U+0000–U+001F to be escaped
 * inside strings, so JSON.parse throws "Bad control character in string
 * literal" — a sampled 3 of 30 pesticide records are affected, i.e. roughly a
 * tenth of the catalogue would be unreachable without this.
 *
 * Tracks in-string state rather than blanket-replacing, because tabs and
 * newlines BETWEEN tokens are legal whitespace and must be left alone.
 */
function sanitizeJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (inString && ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch < ' ') {
      out += ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

async function codexJson<T>(url: string): Promise<T> {
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'Codex');
  const text = await res.text();
  try {
    return JSON.parse(sanitizeJson(text)) as T;
  } catch {
    throw new Error(`Codex returned a body that is not JSON even after control-character repair (${text.slice(0, 120)})`);
  }
}

/** Upstream emits a bare object where a one-element list belongs. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** A search that matched nothing echoes the search form back instead of an
 *  empty result set. Treating that as data yields a confident empty answer. */
function isEmptySearchResponse(payload: Record<string, unknown>): boolean {
  return 'forms' in payload && !('commodities' in payload);
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/** Names arrive as {en, fr, es, ar, ru, zh} with most keys blank. */
function pickName(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return str(o.en) ?? str(o.es) ?? str(o.fr) ?? Object.values(o).map(str).find(Boolean) ?? null;
  }
  return null;
}

// ── Catalogues ────────────────────────────────────────────────────────

interface Named { id: string; name: string }

async function pesticideCatalog(): Promise<Named[]> {
  const d = await codexJson<{ pesticides?: { pesticide?: unknown } }>(`${PEST}/pesticides/index.html`);
  return asArray(d.pesticides?.pesticide as Record<string, unknown>[])
    .map((p) => ({ id: str(p.id) ?? '', name: pickName(p.name) ?? '' }))
    .filter((p) => p.id && p.name);
}

async function vetDrugCatalog(): Promise<(Named & { year: string | null })[]> {
  const d = await codexJson<{ vetDrugs?: { vetDrug?: unknown } }>(`${VETD}/vetdrugs/index.html?lang=en`);
  return asArray(d.vetDrugs?.vetDrug as Record<string, unknown>[])
    .map((v) => ({ id: str(v.id) ?? '', name: pickName(v.name) ?? '', year: str(v.year) }))
    .filter((v) => v.id && v.name);
}

/** Exact match wins over substring, so "2,4-D" isn't buried under compounds
 *  whose names merely contain it. */
function matchByName<T extends Named>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length) return exact;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

/**
 * Resolve a name-or-id argument against the catalogue rather than probing the
 * detail endpoint, because an unknown id answers 500 — indistinguishable from
 * the upstream being down.
 */
async function resolve<T extends Named>(
  rows: T[],
  input: string,
  label: string,
): Promise<{ ok: true; row: T } | { ok: false; result: unknown }> {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) {
    const hit = rows.find((r) => r.id === raw);
    if (hit) return { ok: true, row: hit };
    return {
      ok: false,
      result: {
        found: false,
        reason: 'unknown_id',
        [label]: raw,
        hint: `No Codex ${label} with id ${raw}. Ids come from the matching search tool — they are not CAS or commodity codes.`,
      },
    };
  }
  const hits = matchByName(rows, raw);
  if (hits.length === 1) return { ok: true, row: hits[0] };
  if (hits.length === 0) {
    return {
      ok: false,
      result: {
        found: false,
        reason: 'no_match',
        [label]: raw,
        hint: `No Codex ${label} matched "${raw}". Codex uses ISO common names, so try a shorter fragment or the chemical rather than a brand name. Note that absence here does not mean the substance was never evaluated: this database lists only CURRENTLY adopted limits, and Codex removes entries when it revokes them — chlorpyrifos is absent for exactly that reason.`,
      },
    };
  }
  return {
    ok: false,
    result: {
      found: true,
      ambiguous: true,
      [label]: raw,
      count: hits.length,
      results: hits.slice(0, 25).map((r) => ({ id: r.id, name: r.name })),
      hint: `"${raw}" matched ${hits.length} entries. Re-call with one id.`,
    },
  };
}

// ── Shaping ───────────────────────────────────────────────────────────

/** Fields common to both directions of the pesticide×commodity matrix. */
function shapeMrlCore(r: Record<string, unknown>) {
  return {
    mrl: str(r.mrl),
    mrl_display: str(r.mrlFormatted),
    adopted_year: str(r.cacYear),
    jmpr_year: str(r.jmpr),
    limit_of_determination: str(r.lod),
    // Flags that change how the number is applied — "(fat)" means the limit is
    // on the fat of meat, "E" that it covers extraneous (environmental) residue.
    qualifier: str(r.fatPh),
    residue_basis: str(r.tev),
    footnote: pickName(r.footnote),
  };
}

/** Rows from a PESTICIDE record: each names the commodity it applies to. */
function shapeByCommodity(r: Record<string, unknown>) {
  const c = (r.commodity ?? {}) as Record<string, unknown>;
  const step = (r.step ?? {}) as Record<string, unknown>;
  return {
    ...shapeMrlCore(r),
    commodity: pickName(c.name),
    commodity_id: str(c.id),
    commodity_code: str(c.commCode),
    // "CXL" = adopted Codex limit; a numeric step means still moving through the
    // 8-step adoption procedure and NOT yet binding.
    step_code: str(step.stepCode) ?? str(r.stepCode),
  };
}

/**
 * Rows from a COMMODITY record: each names the pesticide. Deliberately omits
 * the commodity and step fields — the commodity is already the subject of the
 * response, and these rows carry no step, so emitting them would repeat one
 * value and a null across every row and read as missing data.
 */
function shapeByPesticide(r: Record<string, unknown>) {
  const p = (r.pesticide ?? {}) as Record<string, unknown>;
  return {
    ...shapeMrlCore(r),
    pesticide: pickName(p.name),
    pesticide_id: str(p.id),
  };
}

function shapeVetMrl(r: Record<string, unknown>) {
  return {
    mrl: str(r.mrl),
    unit: str(r.mrlUnit),
    species: pickName(r.specie),
    tissue: pickName(r.tissue),
    adopted_year: str(r.year),
    step_code: str(r.stepCode),
    jecfa_meetings: str(r.jecfa),
    status: str(r.status),
    footnote: pickName(r.footnote),
  };
}

/** The per-record legend explaining the qualifier codes on each limit. */
function shapeSymbols(v: unknown) {
  return asArray(v as Record<string, unknown>[])
    .map((s) => ({ symbol: str(s.label), meaning: str(s.text) }))
    .filter((s) => s.symbol && s.meaning);
}

// ── Dispatch ──────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'codex_pesticide_search': {
      const query = reqStr(args, 'query', '"glyphosate"');
      const hits = matchByName(await pesticideCatalog(), query);
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_match',
          query,
          hint: 'No Codex pesticide matched. Codex uses ISO common names — try a shorter fragment, or a chemical name rather than a product brand. This database holds only CURRENTLY adopted limits: a substance whose limits Codex has revoked (chlorpyrifos, for one) is absent rather than listed with zero, so absence is not evidence it was never evaluated.',
        };
      }
      return { found: true, query, count: hits.length, results: hits };
    }

    case 'codex_pesticide_mrls': {
      const input = reqStr(args, 'pesticide', '"glyphosate"');
      const r = await resolve(await pesticideCatalog(), input, 'pesticide');
      if (!r.ok) return r.result;

      const d = await codexJson<Record<string, unknown>>(`${PEST}/pesticides/details.html?id=${encodeURIComponent(r.row.id)}`);
      const mrls = asArray((d.mrls as Record<string, unknown>)?.mrl as Record<string, unknown>[]);
      return {
        found: true,
        id: r.row.id,
        pesticide: str(d.pesticide) ?? r.row.name,
        pesticide_class: str(d.name),
        acceptable_daily_intake: str(d.adi),
        adi_unit: str(d.adiUnit),
        adi_note: str(d.adiNote),
        residue_definition: str(d.residue),
        also_a_veterinary_drug: str(d.vetdFlag) === 'Y',
        count: mrls.length,
        mrls: mrls.map(shapeByCommodity),
        symbol_legend: shapeSymbols((d.symbols as Record<string, unknown>)?.symbol),
        source_url: `https://www.fao.org/fao-who-codexalimentarius/codex-texts/dbs/pestres/pesticide-detail/en/?p_id=${r.row.id}`,
      };
    }

    case 'codex_commodity_search': {
      const query = reqStr(args, 'query', '"apple"');
      const d = await codexJson<Record<string, unknown>>(
        `${PEST}/pesticides/results.html?searchBy=com&commodityText=${encodeURIComponent(query)}&lang=en`,
      );
      if (isEmptySearchResponse(d)) {
        return {
          found: false,
          reason: 'no_match',
          query,
          hint: 'No Codex commodity matched. Codex names foods formally ("Poultry meat", "Milks") — try the singular, or a broader word.',
        };
      }
      const rows = asArray((d.commodities as Record<string, unknown>)?.commodity as Record<string, unknown>[])
        .map((c) => ({ id: str(c.id) ?? '', name: pickName(c.name) ?? '' }))
        .filter((c) => c.id && c.name);
      return { found: rows.length > 0, query, count: rows.length, results: rows };
    }

    case 'codex_commodity_mrls': {
      const input = reqStr(args, 'commodity', '"apple" or "FP 0226"');
      let url: string;
      if (/^\d+$/.test(input)) {
        url = `${PEST}/commodities/details.html?id=${encodeURIComponent(input)}`;
      } else if (/^[A-Z]{2,3}\s*\d{3,4}$/i.test(input)) {
        // A Codex commodity code redirects (with a jsessionid path segment) to
        // the detail document; fetch follows it, so this needs no special case.
        url = `${PEST}/pesticides/results.html?searchBy=cmc&commodityCode=${encodeURIComponent(input)}&lang=en`;
      } else {
        const d = await codexJson<Record<string, unknown>>(
          `${PEST}/pesticides/results.html?searchBy=com&commodityText=${encodeURIComponent(input)}&lang=en`,
        );
        if (isEmptySearchResponse(d)) {
          return {
            found: false,
            reason: 'no_match',
            commodity: input,
            hint: 'No Codex commodity matched that name. Use codex_commodity_search to see the exact wording Codex uses.',
          };
        }
        const rows = asArray((d.commodities as Record<string, unknown>)?.commodity as Record<string, unknown>[])
          .map((c) => ({ id: str(c.id) ?? '', name: pickName(c.name) ?? '' }))
          .filter((c) => c.id && c.name);
        const exact = rows.find((c) => c.name.toLowerCase() === input.trim().toLowerCase());
        if (!exact && rows.length > 1) {
          return {
            found: true,
            ambiguous: true,
            commodity: input,
            count: rows.length,
            results: rows.slice(0, 25),
            hint: `"${input}" matched ${rows.length} Codex commodities, which carry different limits. Re-call with one id.`,
          };
        }
        const chosen = exact ?? rows[0];
        if (!chosen) {
          return { found: false, reason: 'no_match', commodity: input, hint: 'No Codex commodity matched that name.' };
        }
        url = `${PEST}/commodities/details.html?id=${encodeURIComponent(chosen.id)}`;
      }

      const d = await codexJson<Record<string, unknown>>(url);
      if (isEmptySearchResponse(d)) {
        return {
          found: false,
          reason: 'no_match',
          commodity: input,
          hint: 'No Codex commodity has that code. Codes look like "FP 0226" — find one with codex_commodity_search.',
        };
      }
      const mrls = asArray((d.mrls as Record<string, unknown>)?.mrl as Record<string, unknown>[]);
      return {
        found: true,
        commodity: str(d.commodity),
        commodity_code: str(d.commCode),
        count: mrls.length,
        mrls: mrls.map(shapeByPesticide),
        symbol_legend: shapeSymbols((d.symbols as Record<string, unknown>)?.symbol),
      };
    }

    case 'codex_vetdrug_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const all = await vetDrugCatalog();
      const hits = query ? matchByName(all, query) : all;
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_match',
          query,
          hint: 'No Codex veterinary drug matched. Codex covers 85 substances; omit the query to list them all.',
        };
      }
      return { found: true, query: query || null, count: hits.length, results: hits };
    }

    case 'codex_vetdrug_mrls': {
      const input = reqStr(args, 'drug', '"abamectin"');
      const r = await resolve(await vetDrugCatalog(), input, 'drug');
      if (!r.ok) return r.result;

      const payload = await codexJson<{ vetDrug?: Record<string, unknown> }>(
        `${VETD}/vetdrugs/details.html?id=${encodeURIComponent(r.row.id)}`,
      );
      const v = payload.vetDrug ?? {};
      const fc = (v['functional-class'] ?? {}) as Record<string, unknown>;
      const mrls = asArray((v.mrls as Record<string, unknown>)?.mrl as Record<string, unknown>[]);
      return {
        found: true,
        id: r.row.id,
        drug: str(v.name) ?? r.row.name,
        functional_class: str(fc.name),
        functional_class_year: str(fc.year),
        // Cross-reference into the JECFA safety evaluations (the jecfa pack).
        jecfa_chemical_id: str(fc.newJecfaId),
        also_a_pesticide: str(v.pestFlag) === 'Y',
        count: mrls.length,
        mrls: mrls.map(shapeVetMrl),
        // Zero limits is a finding, not a gap: Codex withholds an MRL for
        // substances it judges to have no safe residue level.
        note:
          mrls.length === 0
            ? 'Codex has adopted no maximum residue limit for this substance. For some drugs that is a deliberate decision that no safe residue level exists, not missing data — check the JECFA evaluation.'
            : null,
        source_url: `https://www.fao.org/fao-who-codexalimentarius/codex-texts/dbs/vetdrugs/veterinary-drug-detail/en/?d_id=${r.row.id}`,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

export { sanitizeJson, asArray, isEmptySearchResponse, matchByName };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
