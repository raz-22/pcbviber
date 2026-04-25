/**
 * TanStack Query hooks for /api/orgs/:orgId/members and /invites.
 *
 * Cache layout:
 *   ["members", orgId]              — list
 *   ["invites", orgId]              — pending invites list
 *
 * Mutations invalidate by prefix so a single mutateAsync handles both
 * the list refresh and any per-row caches a future page might add.
 *
 * memberErrorMessage is the single mapper for every member/invite
 * stable code; the SPA's pages route every shown error through it
 * so the wording stays consistent across screens.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ChangeRoleInput,
  type CreateInviteInput,
  type Invite,
  type Member,
} from "./api";

export const membersKey = (orgId: string) => ["members", orgId] as const;
export const invitesKey = (orgId: string) => ["invites", orgId] as const;

export function invalidateMembers(qc: QueryClient, orgId: string) {
  qc.invalidateQueries({ queryKey: membersKey(orgId) });
}

export function invalidateInvites(qc: QueryClient, orgId: string) {
  qc.invalidateQueries({ queryKey: invitesKey(orgId) });
}

// ─── Queries ─────────────────────────────────────────────────────────

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: orgId ? membersKey(orgId) : ["members", "(none)"],
    queryFn: async (): Promise<Member[]> => {
      const res = await api.listMembers(orgId!);
      return res.members;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

export function useInvites(orgId: string | undefined) {
  return useQuery({
    queryKey: orgId ? invitesKey(orgId) : ["invites", "(none)"],
    queryFn: async (): Promise<Invite[]> => {
      const res = await api.listInvites(orgId!);
      return res.invites;
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────

export function useChangeRole(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: ChangeRoleInput }) =>
      api.changeMemberRole(orgId, userId, input),
    onSuccess: () => invalidateMembers(qc, orgId),
  });
}

export function useRemoveMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.removeMember(orgId, userId),
    onSuccess: () => invalidateMembers(qc, orgId),
  });
}

export function useCreateInvite(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteInput) => api.createInvite(orgId, input),
    onSuccess: () => invalidateInvites(qc, orgId),
  });
}

export function useRevokeInvite(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.revokeInvite(orgId, inviteId),
    onSuccess: () => invalidateInvites(qc, orgId),
  });
}

export function useAcceptInvite() {
  return useMutation({
    mutationFn: (token: string) => api.acceptInvite(token),
  });
}

// ─── Error message mapper ────────────────────────────────────────────

/**
 * Maps a member/invite-flow ApiError to a user-facing string. Every
 * member-management page routes its `mutation.error` through this so
 * the wording stays uniform.
 */
export function memberErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      // Members
      case "cannot_demote_last_owner":
        return "This is the only owner — promote someone else to owner first.";
      case "cannot_remove_last_owner":
        return "This is the only owner — promote someone else to owner first, then try again.";
      case "already_member":
        return "That email is already a member of this organization.";
      // Invites — create
      case "invalid_input":
        return "Some fields are invalid. Check the form and try again.";
      // Invites — accept
      case "invite_email_mismatch":
        return "This invite was sent to a different email. Sign in with that account to accept.";
      case "invite_expired":
        return "This invite has expired. Ask an admin to send a new one.";
      case "invite_already_accepted":
        return "This invite has already been accepted.";
      // Common
      case "forbidden":
        return "You don't have permission to perform this action.";
      case "not_found":
        return "Not found.";
      case "not_authenticated":
        return "Your session has expired. Please log in again.";
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return "Network error. Please check your connection and retry.";
}
