/**
 * NexarService — wraps the Nexar GraphQL API (https://api.nexar.com/graphql)
 *
 * Nexar is the unified GraphQL gateway for:
 *   - Altium 365 design data (workspaces, projects, components, BOMs)
 *   - Octopart supply chain data (part search, stock, pricing, datasheets)
 *
 * Auth: OAuth2 client_credentials → https://identity.nexar.com/connect/token
 */

import type {
  AltiumConfig,
  AltiumWorkspace,
  AltiumProject,
  AltiumComponent,
  PartSearchResult,
} from "@altium-mcp/shared";

const NEXAR_TOKEN_URL = "https://identity.nexar.com/connect/token";
const NEXAR_GRAPHQL_URL = "https://api.nexar.com/graphql";

export class NexarService {
  private config: AltiumConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: AltiumConfig) {
    this.config = config;
  }

  // ── Auth ──────────────────────────────────────────────

  private async authenticate(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.nexarClientId,
      client_secret: this.config.nexarClientSecret,
    });

    const res = await fetch(NEXAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      throw new Error(`Nexar auth failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.accessToken;
  }

  private async query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.authenticate();

    const res = await fetch(NEXAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: gql, variables }),
    });

    if (!res.ok) {
      throw new Error(`Nexar query failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as { data: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`Nexar GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
    }
    return json.data;
  }

  // ── Design Data (Altium 365) ──────────────────────────

  async listWorkspaces(): Promise<AltiumWorkspace[]> {
    const data = await this.query<{ desWorkspaces: AltiumWorkspace[] }>(`
      query {
        desWorkspaces {
          id
          name
          url
          description
        }
      }
    `);
    return data.desWorkspaces;
  }

  async listProjects(workspaceUrl: string): Promise<AltiumProject[]> {
    const data = await this.query<{ desProjects: AltiumProject[] }>(
      `
      query($workspaceUrl: String!) {
        desProjects(workspaceUrl: $workspaceUrl) {
          id
          name
          description
        }
      }
    `,
      { workspaceUrl }
    );
    return data.desProjects;
  }

  async listComponents(workspaceUrl: string): Promise<AltiumComponent[]> {
    const data = await this.query<{ desLibrary: { nodes: AltiumComponent[] } }>(
      `
      query($workspaceUrl: String!) {
        desLibrary(workspaceUrl: $workspaceUrl) {
          nodes {
            id
            name
            description
            designItemId
            comment
          }
        }
      }
    `,
      { workspaceUrl }
    );
    return data.desLibrary.nodes;
  }

  // ── Supply Chain (Octopart) ───────────────────────────

  async searchParts(query: string, limit: number = 10): Promise<PartSearchResult[]> {
    const data = await this.query<{
      supSearchMpn: {
        results: {
          part: {
            mpn: string;
            manufacturer: { name: string };
            shortDescription: string;
            category: { name: string };
            bestDatasheet: { url: string } | null;
            estimatedFactoryLeadDays: number | null;
            sellers: {
              company: { name: string };
              offers: {
                sku: string;
                inventoryLevel: number;
                moq: number;
                prices: { quantity: number; price: number; currency: string }[];
              }[];
            }[];
          };
        }[];
      };
    }>(
      `
      query($q: String!, $limit: Int!) {
        supSearchMpn(q: $q, limit: $limit) {
          results {
            part {
              mpn
              manufacturer { name }
              shortDescription
              category { name }
              bestDatasheet { url }
              estimatedFactoryLeadDays
              sellers {
                company { name }
                offers {
                  sku
                  inventoryLevel
                  moq
                  prices { quantity price currency }
                }
              }
            }
          }
        }
      }
    `,
      { q: query, limit }
    );

    return data.supSearchMpn.results.map((r) => ({
      mpn: r.part.mpn,
      manufacturer: r.part.manufacturer.name,
      description: r.part.shortDescription,
      category: r.part.category?.name ?? "Unknown",
      datasheetUrl: r.part.bestDatasheet?.url,
      lifecycle: "Active",
      offers: r.part.sellers.flatMap((s) =>
        s.offers.map((o) => ({
          supplier: s.company.name,
          sku: o.sku,
          stock: o.inventoryLevel,
          moq: o.moq,
          prices: o.prices,
          leadTimeDays: r.part.estimatedFactoryLeadDays ?? undefined,
        }))
      ),
    }));
  }
}
