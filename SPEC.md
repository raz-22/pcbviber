# Altium MCP — Phase 2 + Phase 4 Design Spec

Implementation-ready spec for finishing Phase 2 (three BOM/manufacturing tools)
and layering Phase 4 prompts on top. Stubs already exist in
`apps/server/src/handlers/manufacturing.ts`; this spec fills them in.

## 0. Pre-work — Nexar schema introspection (MANDATORY)

GraphQL field names in the spec below (`desProjectById`, `desRelease`, etc.) are
from public Nexar docs and may drift. Verify before coding:

1. Open `https://api.nexar.com/graphql` in the Nitro playground.
2. Run introspection on `DesProject`, `DesBomItem`, `DesRelease` — confirm field names.
3. If drift, adjust the GraphQL strings in `apps/server/src/services/nexar.ts`; no other code changes needed.
4. Document the verification date in a comment at the top of `nexar.ts`.

## 1. Type additions — `packages/shared/src/types.ts`

Extend `BomItem` with optional new fields (backward compatible):
`componentId?`, `lifecycle?`, `stockStatus?`, `totalStock?`, `alternativesAvailable?`.

Add: `BomCostBreakdown`, `ProjectRelease`, `ManufacturingExportJob`.

## 2. NexarService extensions

### 2.1 `getProjectBom(workspaceUrl, projectId) → BomItem[]`

```graphql
query($workspaceUrl: String!, $projectId: ID!) {
  desProjectById(workspaceUrl: $workspaceUrl, id: $projectId) {
    latestRelease {
      id
      revision
      bom {
        items {
          designators
          comment
          description
          footprint
          quantity
          manufacturerPartNumber
          manufacturer
          componentId
          lifecycle { state }
        }
      }
    }
  }
}
```

Map `designators` array → comma-joined `designator`. Throw if no latest release.

### 2.2 `listProjectReleases(workspaceUrl, projectId) → ProjectRelease[]`

Returns releases sorted newest-first. Needed by `export_manufacturing_data` to resolve "latest".

### 2.3 `requestManufacturingExport(args) → ManufacturingExportJob` + `pollExportJob(jobId)`

Altium 365 exports are async. Submit mutation → poll job until `complete` / `failed`.

```graphql
mutation($input: DesCreateManufacturingOutputInput!) {
  desCreateManufacturingOutput(input: $input) {
    job { id status downloadUrl expiresAt error }
  }
}
```

Output-type mapping:

| MCP value          | Nexar `outputType` (verify) |
|--------------------|-----------------------------|
| `gerber_274x`      | `GERBER_274X`               |
| `gerber_x2`        | `GERBER_X2`                 |
| `odb++`            | `ODB_PP`                    |
| `ipc2581`          | `IPC_2581`                  |
| `pick_and_place`   | `PICK_AND_PLACE`            |

## 3. Phase 2 tool handlers — fill `apps/server/src/handlers/manufacturing.ts`

### 3.1 `getProjectBom`
1. `await nexar.getProjectBom(...)`
2. If `includeAlternatives`: for up to 50 lines, parallel `searchParts(mpn, 3)` with `Promise.allSettled`; set `alternativesAvailable`.
3. Enrich `totalStock` / `stockStatus` per line:
   - `in_stock` if totalStock ≥ quantity × 10
   - `low_stock` if ≥ quantity
   - else `out_of_stock` / `unknown`
4. Return `{ projectId, releaseId, lineCount, uniqueParts, items, truncated }`.
5. Errors: project-not-found, no-release, partial-enrichment-success with warnings.

### 3.2 `analyzeBomCost`
1. Fetch BOM.
2. Unique MPNs → parallel `searchParts(mpn, 5)`, concurrency cap 10.
3. Per production quantity: pick best offer per line at `totalPartQty = line.quantity × quantity`; handle MOQ tier; count `unpricedCount`.
4. Currency: prefer USD; flag `mixedCurrencies: true` if mixed; **no FX conversion in v1**.
5. Risk rules: `obsolete` (lifecycle), `single_source` (one supplier), `low_stock`, `long_lead_time` (>84 days).

### 3.3 `exportManufacturingData`
1. Resolve release (explicit or latest); error if none.
2. Submit mutation; poll with exponential backoff `delay = min(10s, 1s × 1.5^attempt)`.
3. Wall-clock cap: `timeoutSeconds` param (default 180, max 600).
4. On timeout: return `status: "queued"` + `jobId` so caller can re-poll. Do NOT block > timeout.
5. On `failed`: return with `isError: true` at the MCP layer.

Add `timeoutSeconds` to the input schema (min 10, max 600, default 180).

## 4. Phase 4 prompts — new file `apps/server/src/prompts/workflows.ts`

Register via `server.prompt(...)` after tool registrations in `index.ts`.

### 4.1 `review_bom(workspaceUrl, projectId, targetQuantity?)`

Prompt text instructs the model to:
1. Call `get_project_bom` with `includeAlternatives: true`.
2. Call `analyze_bom_cost` with `quantities: [1, 10, targetQuantity ?? 1000]`.
3. Produce: Summary · Top 5 cost drivers · Supply risk · Lifecycle concerns · Action items.

### 4.2 `prepare_for_fab(workspaceUrl, projectId, fabFormat)`

Prompt text instructs the model to:
1. Call `check_production_readiness`; stop and report if any checks fail.
2. Confirm BOM has no unpriced/obsolete lines; stop if not.
3. Call `export_manufacturing_data` with `fabFormat`; surface `jobId` on timeout.
4. On success, also call with `format: "pick_and_place"`.
5. Emit `READY_FOR_FAB: YES|NO` as final line.

## 5. Implementation order

1. Schema introspection (§0)
2. Type additions (§1)
3. `getProjectBom` service + handler (§2.1, §3.1)
4. `analyzeBomCost` handler (§3.2)
5. Release + export service + handler (§2.2, §2.3, §3.3)
6. Phase 4 prompts (§4)

Each step must leave `pnpm -r build` green and `pnpm -F @altium-mcp/server inspect` working against the tool it just added.

## 6. Test matrix for `pnpm -F @altium-mcp/server inspect`

| Tool                        | Input                                     | Expected                             |
|-----------------------------|-------------------------------------------|--------------------------------------|
| `get_project_bom`           | real project, `alternatives:false`        | items array, `lineCount > 0`         |
| `get_project_bom`           | same, `alternatives:true`                 | `alternativesAvailable` populated    |
| `get_project_bom`           | invalid projectId                         | `isError: true`, clear message       |
| `analyze_bom_cost`          | real project, `[1, 100]`                  | two `perQuantity` entries            |
| `analyze_bom_cost`          | project with obsolete MPN                 | `riskItems` includes it              |
| `export_manufacturing_data` | real project, `gerber_x2`                 | `status:"complete"`, valid URL       |
| `export_manufacturing_data` | nonexistent releaseId                     | clear error, no poll loop            |

## 7. Out of scope (don't drift)

- Writing to Altium Designer (desktop) — Phase 3.
- DRC — `run_drc_summary` stays stubbed; real DRC needs desktop relay.
- Currency conversion — flag, never convert.
- BOM editing — read-only in Phase 2.
- Cross-reference beyond description search — until Nexar exposes a stable endpoint.

## 8. Risk log

| Risk | Mitigation |
|---|---|
| Nexar schema drift | §0 introspection gate |
| Long export blocks LLM turn | `timeoutSeconds` + return `jobId` on timeout |
| Octopart fanout for large BOMs | Concurrency cap (10) + 50-line cap for alternatives |
| Mixed currencies wrong totals | Explicit `mixedCurrencies: true` flag |
| Nexar rate limits | Reuse auth token, batch unique MPNs |
