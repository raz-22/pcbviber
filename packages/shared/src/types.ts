// ─────────────────────────────────────────────────────────
// Altium 365 types (from Nexar GraphQL + REST APIs)
// ─────────────────────────────────────────────────────────

export interface AltiumWorkspace {
  id: string;
  name: string;
  url: string;
  description?: string;
}

export interface AltiumProject {
  id: string;
  name: string;
  description?: string;
  workspaceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AltiumComponent {
  id: string;
  name: string;
  description?: string;
  designItemId: string;
  parameters: Record<string, string>;
  lifecycle?: {
    state: string;
    stateColor?: string;
  };
}

export interface BomItem {
  designator: string;
  comment: string;
  description: string;
  footprint: string;
  quantity: number;
  partNumber?: string;
  manufacturer?: string;
  supplier?: string;
  unitPrice?: number;
}

export interface DesignRule {
  name: string;
  category: string;
  value: string;
  unit?: string;
  enabled: boolean;
}

export interface ManufacturingOutput {
  type: "gerber" | "odb++" | "ipc2581" | "pick_and_place" | "bom";
  format: string;
  layers?: string[];
  url?: string;
}

// ─────────────────────────────────────────────────────────
// Nexar / Octopart supply chain types
// ─────────────────────────────────────────────────────────

export interface PartSearchResult {
  mpn: string;
  manufacturer: string;
  description: string;
  category: string;
  datasheetUrl?: string;
  lifecycle: string;
  offers: PartOffer[];
}

export interface PartOffer {
  supplier: string;
  sku: string;
  stock: number;
  moq: number;
  prices: { quantity: number; price: number; currency: string }[];
  leadTimeDays?: number;
}

export interface PartAvailabilitySummary {
  mpn: string;
  manufacturer: string;
  description: string;
  lifecycle: string;
  datasheetUrl?: string;
  totalStock: number;
  suppliers: {
    supplier: string;
    sku: string;
    stock: number;
    moq: number;
    bestPrice: string;
    leadTimeDays?: number;
  }[];
}

// ─────────────────────────────────────────────────────────
// Auth config
// ─────────────────────────────────────────────────────────

export interface AltiumConfig {
  nexarClientId: string;
  nexarClientSecret: string;
  altium365WorkspaceUrl?: string;
  /** For Requirements & Systems Portal REST API */
  restApiToken?: string;
}
