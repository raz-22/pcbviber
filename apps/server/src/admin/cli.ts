#!/usr/bin/env node

/**
 * Admin bootstrap CLI.
 *
 * Out-of-band operator tool for recovery scenarios — locked-out
 * owners, manual admin promotion, post-deploy inspection. Runs
 * server-side, talks to the same DATABASE_URL the app does, but
 * connects as the admin role: RLS-bypassed by design (cross-tenant
 * ops are the whole point).
 *
 * Subcommands:
 *   orgs list                                    list orgs + member counts
 *   users list [--email <substr>]                list users + membership counts
 *   members add --org <slug|id> --email <addr> --role <role>
 *                                                directly add a member (no invite)
 *   members promote --org <slug|id> --email <addr> --role <role>
 *                                                change an existing member's role
 *
 * Common flags:
 *   --json    machine-readable JSON output (default: human table)
 *   --help    print usage and exit 0
 *
 * Every mutating subcommand writes an audit row tagged
 * `admin.<verb>` with `actorUserId: null` (system actor); operators
 * grep `action LIKE 'admin.%'` to see who ran what.
 *
 * Exits non-zero on user error (missing flag, unknown subcommand)
 * or runtime failure. Zero on success.
 */

import { prisma } from "@altium-mcp/db";
import { listOrgs } from "./orgs.js";
import { listUsers } from "./users.js";
import { addMember, promoteMember } from "./members.js";

const USAGE = `pcbviber-admin — operator CLI

Usage:
  pcbviber-admin <command> [...args] [--json]

Commands:
  orgs list                                   list orgs + member counts
  users list [--email <substr>]               list users + membership counts
  members add --org <slug|id> --email <addr> --role <role>
                                              add a member directly (no invite)
  members promote --org <slug|id> --email <addr> --role <role>
                                              change an existing member's role

Roles: owner | admin | member | billing_only

Common flags:
  --json     machine-readable JSON output (default: human table)
  --help     print this message
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Tiny argv parser. Supports `--name value` and `--name=value` and
 * boolean flags `--flag`. Positional args are anything that doesn't
 * start with `--`. Sufficient for our 4 subcommands; introducing a
 * full library is overkill.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

function requireFlag(
  flags: Record<string, string | boolean>,
  name: string
): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`missing required flag: --${name}`);
  }
  return value;
}

class UsageError extends Error {}

/**
 * Format an array of records as either human-readable text columns
 * (when `json` is false) or `JSON.stringify(rows, null, 2)`. Picks
 * column widths from the longest value per column.
 */
function format(
  rows: ReadonlyArray<Readonly<Record<string, string | number>>>,
  columns: readonly string[],
  json: boolean
): string {
  if (json) return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return "(no rows)";
  const widths: Record<string, number> = {};
  for (const c of columns) {
    widths[c] = c.length;
    for (const r of rows) {
      const cell = String(r[c] ?? "");
      if (cell.length > widths[c]!) widths[c] = cell.length;
    }
  }
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const header = columns.map((c) => pad(c, widths[c]!)).join("  ");
  const sep = columns.map((c) => "─".repeat(widths[c]!)).join("  ");
  const body = rows
    .map((r) =>
      columns.map((c) => pad(String(r[c] ?? ""), widths[c]!)).join("  ")
    )
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

export async function runCli(argv: readonly string[]): Promise<{
  output: string;
  exitCode: number;
}> {
  const { positional, flags } = parseArgs(argv);
  const json = flags.json === true;

  if (flags.help === true || positional.length === 0) {
    return { output: USAGE.trimEnd(), exitCode: 0 };
  }

  try {
    const [domain, verb, ...rest] = positional;

    if (domain === "orgs" && verb === "list") {
      const orgs = await listOrgs(prisma);
      return {
        output: format(
          orgs as unknown as Array<Record<string, string | number>>,
          ["id", "slug", "name", "billingStatus", "members"],
          json
        ),
        exitCode: 0,
      };
    }

    if (domain === "users" && verb === "list") {
      const emailFilter =
        typeof flags.email === "string" ? flags.email : undefined;
      const users = await listUsers(prisma, { emailContains: emailFilter });
      return {
        output: format(
          users as unknown as Array<Record<string, string | number>>,
          ["id", "email", "memberships"],
          json
        ),
        exitCode: 0,
      };
    }

    if (domain === "members" && verb === "add") {
      const org = requireFlag(flags, "org");
      const email = requireFlag(flags, "email");
      const role = requireFlag(flags, "role");
      const result = await addMember(prisma, { org, email, role });
      return {
        output: json
          ? JSON.stringify(result, null, 2)
          : `added: ${result.email} → ${result.orgSlug} (${result.role})`,
        exitCode: 0,
      };
    }

    if (domain === "members" && verb === "promote") {
      const org = requireFlag(flags, "org");
      const email = requireFlag(flags, "email");
      const role = requireFlag(flags, "role");
      const result = await promoteMember(prisma, { org, email, role });
      return {
        output: json
          ? JSON.stringify(result, null, 2)
          : `promoted: ${result.email} → ${result.orgSlug} (${result.from} → ${result.to})`,
        exitCode: 0,
      };
    }

    // Used the binary but typo'd a subcommand: print usage to stderr-
    // shaped output and exit non-zero. Distinct from --help which
    // exits 0.
    if (rest.length > 0 || domain !== undefined) {
      throw new UsageError(
        `unknown command: ${[domain, verb, ...rest].filter(Boolean).join(" ")}`
      );
    }
    return { output: USAGE.trimEnd(), exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isUsage = err instanceof UsageError;
    const text = isUsage ? `${message}\n\n${USAGE.trimEnd()}` : `error: ${message}`;
    return { output: text, exitCode: isUsage ? 2 : 1 };
  }
}

// Run only when invoked directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  runCli(argv)
    .then(async ({ output, exitCode }) => {
      // Write to stdout for output, then disconnect Prisma so the
      // process exits cleanly (Prisma keeps the event loop alive).
      process.stdout.write(`${output}\n`);
      await prisma.$disconnect();
      process.exit(exitCode);
    })
    .catch(async (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
