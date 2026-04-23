import { z } from "zod";

// Input schemas shared between MCP tools and REST endpoints.

export const SearchPartsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe("Part number, description, or parametric search (e.g. '100uF 25V capacitor MLCC')"),
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Max results to return"),
});
export type SearchPartsInput = z.infer<typeof SearchPartsInput>;

export const CheckAvailabilityInput = z.object({
  mpn: z.string().min(1).describe("Exact manufacturer part number"),
});
export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInput>;

export const ListLibraryComponentsInput = z.object({
  workspaceUrl: z.string().url().describe("Altium 365 workspace URL"),
});
export type ListLibraryComponentsInput = z.infer<typeof ListLibraryComponentsInput>;

export const FindAlternativePartsInput = z.object({
  mpn: z.string().min(1),
  criteria: z
    .enum(["pin_compatible", "parametric_match", "same_family"])
    .default("parametric_match"),
});
export type FindAlternativePartsInput = z.infer<typeof FindAlternativePartsInput>;
