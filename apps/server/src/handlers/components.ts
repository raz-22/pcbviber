/**
 * Pure async functions for the component/supply-chain tools.
 *
 * Reused by:
 *  - the MCP tool wrappers in src/tools/components.ts
 *  - the REST BFF routes in src/http.ts
 */

import type { NexarService } from "../services/nexar.js";
import type {
  PartSearchResult,
  PartAvailabilitySummary,
  AltiumComponent,
  SearchPartsInput,
  CheckAvailabilityInput,
  ListLibraryComponentsInput,
  FindAlternativePartsInput,
} from "@altium-mcp/shared";

export async function searchParts(
  nexar: NexarService,
  { query, limit }: SearchPartsInput
): Promise<PartSearchResult[]> {
  return nexar.searchParts(query, limit);
}

export async function checkPartAvailability(
  nexar: NexarService,
  { mpn }: CheckAvailabilityInput
): Promise<PartAvailabilitySummary | { notFound: true; mpn: string }> {
  const results = await nexar.searchParts(mpn, 1);
  if (results.length === 0) {
    return { notFound: true, mpn };
  }
  const part = results[0];
  return {
    mpn: part.mpn,
    manufacturer: part.manufacturer,
    description: part.description,
    lifecycle: part.lifecycle,
    datasheetUrl: part.datasheetUrl,
    totalStock: part.offers.reduce((sum, o) => sum + o.stock, 0),
    suppliers: part.offers.map((o) => ({
      supplier: o.supplier,
      sku: o.sku,
      stock: o.stock,
      moq: o.moq,
      bestPrice: o.prices[0] ? `${o.prices[0].currency} ${o.prices[0].price}` : "N/A",
      leadTimeDays: o.leadTimeDays,
    })),
  };
}

export async function listLibraryComponents(
  nexar: NexarService,
  { workspaceUrl }: ListLibraryComponentsInput
): Promise<AltiumComponent[]> {
  return nexar.listComponents(workspaceUrl);
}

export async function findAlternativeParts(
  nexar: NexarService,
  { mpn, criteria }: FindAlternativePartsInput
): Promise<{
  originalPart: string;
  criteria: string;
  alternatives: PartSearchResult[];
  note: string;
} | { notFound: true; mpn: string }> {
  const original = await nexar.searchParts(mpn, 1);
  if (original.length === 0) {
    return { notFound: true, mpn };
  }
  const alternatives = await nexar.searchParts(original[0].description, 10);
  return {
    originalPart: original[0].mpn,
    criteria,
    alternatives: alternatives.filter((p) => p.mpn !== mpn),
    note: "Phase 1: Alternatives based on description match. Cross-reference matching coming in Phase 2.",
  };
}
