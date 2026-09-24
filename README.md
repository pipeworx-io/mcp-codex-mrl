# Codex MRL — Maximum Residue Limits (FAO/WHO Codex Alimentarius)

The internationally agreed legal ceilings for **pesticide residues** and **veterinary drug residues** in food, adopted by the Codex Alimentarius Commission. Codex MRLs are the reference point for food trade — a shipment rejected at a border is usually rejected against one of these numbers.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

This is the *permission* side of food chemistry. The *safety* side — the Acceptable Daily Intakes and toxicological evaluations behind the limits — is the [`jecfa`](../jecfa) pack; veterinary drug records here carry a `jecfa_chemical_id` that links the two.

## Tools

| Tool | What it answers |
|---|---|
| `codex_pesticide_search` | Find a pesticide by name → id |
| `codex_pesticide_mrls` | One pesticide → ADI, residue definition, and its limit in every commodity |
| `codex_commodity_search` | Find a food commodity by name → id |
| `codex_commodity_mrls` | One food → every pesticide limit that applies to it |
| `codex_vetdrug_search` | List or search the 85 veterinary drugs |
| `codex_vetdrug_mrls` | One drug → limits by species and tissue, plus its JECFA cross-reference |

## Coverage

240 pesticides and 85 veterinary drugs, with limits indexed in both directions (by substance and by food). Pesticide limits carry their adoption year, the JMPR evaluation year, and the step code — `CXL` means an adopted Codex limit; a numeric step means the limit is still moving through the 8-step adoption procedure and is **not yet binding**.

## Auth

None. Keyless, no registration, no quota.

## Data sources

- Pesticide residues: <https://www.fao.org/fao-who-codexalimentarius/codex-texts/dbs/pestres/en/>
- Veterinary drug residues: <https://www.fao.org/fao-who-codexalimentarius/codex-texts/dbs/vetdrugs/en/>

No documented API. These endpoints back the site's own jQuery pages, so they are undocumented and unversioned and can drift without notice.

## What is NOT here: GSFA

Codex's third database — **GSFA**, the General Standard for Food Additives, which is what says whether an additive is permitted in a given food and at what level — is **not covered**, because it is not reachable from a server. `fao.org/gsfaonline` sits behind a Cloudflare JavaScript challenge that returns 403 to every non-browser client, including for the standard's own PDF. This is not an IP-reputation block, so an egress proxy does not help: the SharePoint mirror requires FAO SSO, the site's own `sh-proxy` returns the same 403, and FAO's OpenKnowledge repository API refuses too. Reaching GSFA would need a browser-driven scrape, which is a different kind of project.

## Gotchas

Four upstream behaviours produce wrong answers if trusted. All are guarded here, but they matter if you extend it:

1. **About 10% of pesticide records are invalid JSON.** Commodity names contain raw tab characters inside string literals — `"Dry peas \t\t(subgroup)"`. RFC 8259 forbids unescaped U+0000–U+001F inside strings, so `JSON.parse` throws `Bad control character in string literal` and the record is simply unreachable. Sampling 30 records found 3 affected, including glyphosate. `sanitizeJson()` escapes control characters **inside strings only**, tracking in-string state, because tabs and newlines *between* tokens are legal whitespace that must be left alone.

2. **A search that matches nothing returns the search form, not an empty list.** Ask for a commodity that doesn't exist and you get back `{forms: {...}}` describing the search UI. Code that looks for `commodities` and finds nothing can easily report "no limits apply" — a confident wrong answer. `isEmptySearchResponse()` distinguishes the two shapes.

3. **Unknown ids answer HTTP 500, not 404.** So a bad id is indistinguishable from the upstream being down. Both `codex_pesticide_mrls` and `codex_vetdrug_mrls` resolve their argument against the catalogue *first* and never probe a detail endpoint with an id they haven't seen.

4. **Absence and zero are different, and both are meaningful.**
   - **Zero limits** is a finding: chloramphenicol returns `count: 0` because Codex declines to set any MRL for a substance it judges to have no safe residue level. Reporting that as "no data" inverts the meaning.
   - **A missing substance** is also a finding: this database lists only *currently adopted* limits, and Codex **removes** entries when it revokes them. Chlorpyrifos is absent for exactly that reason — verified against upstream's own search, which likewise returns nothing. So absence is not evidence a substance was never evaluated, and the `no_match` hints say so.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "codex-mrl": {
      "url": "https://gateway.pipeworx.io/codex-mrl/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/codex-mrl/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/codex_pesticide_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"glyphosate"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/codex_pesticide_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "codex-mrl": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-codex-mrl"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-codex-mrl
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Codex Mrl data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
