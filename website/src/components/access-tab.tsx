// Access tab: org members table with inline role editing and removal
// (admins only), plus secret-link invites — ported from sigillo's
// access-table + invite-dialog. Also exports AcceptInviteButton used by
// the standalone /invite/:invitationId page.
'use client'

import { useActionState, useState } from 'react'
import { ErrorBoundary, router, useLoaderData } from 'spiceflow/react'
import { CheckIcon, CopyIcon, LinkIcon, TrashIcon, UserPlusIcon } from 'lucide-react'
import { acceptInvite, createInvite, removeMember, updateMemberRole } from '../actions.tsx'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Input, NativeSelect, Spinner } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'

type Member = {
  memberId: string
  role: 'admin' | 'member'
  createdAt: number
  userId: string
  user: { name: string; email: string; image: string | null } | null
}

/** Deterministic UTC date (yyyy-mm-dd). toLocaleDateString caused SSR
 *  hydration mismatches: workerd and the browser format locales
 *  differently (03/07/2026 vs 7/3/2026). */
function formatJoinedDate(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function AccessTab() {
  const { role, members } = useLoaderData('/org/:orgId/members')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Access</h1>
          <p className="text-sm text-muted-foreground">
            Manage who can use this organization. Members can manage and review every event.
          </p>
        </div>
        {role === 'admin' ? <InviteButton /> : null}
      </div>
      <AccessTable members={members} />
    </div>
  )
}

function memberDisplayName(member: Member) {
  return member.user?.name || member.user?.email || 'Unknown user'
}

function AccessTable({ members }: { members: Member[] }) {
  const { role, currentUserId, orgKind, ownerUserId } = useLoaderData('/org/:orgId/members')
  const canManage = role === 'admin'
  const [roleOverrides, setRoleOverrides] = useState<Record<string, Member['role']>>({})
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function getRole(member: Member) {
    return roleOverrides[member.memberId] ?? member.role
  }

  const adminCount = members.reduce((count, member) => count + (getRole(member) === 'admin' ? 1 : 0), 0)

  function saveRole(member: Member, nextRole: Member['role']) {
    const previousRole = getRole(member)
    setError(null)
    setRoleOverrides((current) => ({ ...current, [member.memberId]: nextRole }))
    setPendingRoleId(member.memberId)
    void (async () => {
      try {
        await updateMemberRole({ memberId: member.memberId, role: nextRole })
      } catch (err) {
        setRoleOverrides((current) => ({ ...current, [member.memberId]: previousRole }))
        setError(err instanceof Error ? err.message : 'Failed to update role')
      } finally {
        setPendingRoleId((current) => (current === member.memberId ? null : current))
      }
    })()
  }

  function remove(member: Member) {
    if (!window.confirm(`Remove ${memberDisplayName(member)} from this organization?`)) return
    setError(null)
    setPendingDeleteId(member.memberId)
    void (async () => {
      try {
        // Server actions automatically re-render the page with fresh
        // loader data, so the members table updates without a reload.
        await removeMember({ memberId: member.memberId })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove member')
      } finally {
        setPendingDeleteId(null)
      }
    })()
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Frame className="w-full">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-1/4" />
            <col className="w-1/3" />
            <col className="w-36" />
            <col className="w-32" />
            {canManage ? <col className="w-14" /> : null}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {canManage ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const currentRole = getRole(member)
              const isSavingRole = pendingRoleId === member.memberId
              const isDeleting = pendingDeleteId === member.memberId
              const isBusy = isSavingRole || isDeleting
              const isCurrentUser = member.userId === currentUserId
              // The personal-org owner is a permanent admin; other admins
              // can only step down while another admin remains.
              const isPermanentAdmin = orgKind === 'personal' && member.userId === ownerUserId
              const isLastAdmin = currentRole === 'admin' && adminCount === 1
              const locked = isPermanentAdmin || isLastAdmin

              return (
                <TableRow key={member.memberId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {member.user?.image ? (
                        <img src={member.user.image} alt="" className="size-6 rounded-full object-cover" />
                      ) : (
                        <div className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                          {memberDisplayName(member).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-sm font-medium">
                        {member.user?.name || '—'}
                        {isCurrentUser ? <span className="text-muted-foreground font-normal"> (you)</span> : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{member.user?.email || '—'}</span>
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <div className="relative w-full">
                        <NativeSelect
                          disabled={isBusy}
                          value={currentRole}
                          onChange={(event) => {
                            const nextRole: Member['role'] =
                              event.currentTarget.value === 'admin' ? 'admin' : 'member'
                            if (nextRole !== currentRole) saveRole(member, nextRole)
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option disabled={locked} value="member">Member</option>
                        </NativeSelect>
                        {isSavingRole ? (
                          <Spinner className="absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs font-medium capitalize">{currentRole}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatJoinedDate(member.createdAt)}
                    </span>
                  </TableCell>
                  {canManage ? (
                    <TableCell className="p-0">
                      <Button
                        aria-label={isCurrentUser ? 'Leave organization' : 'Remove member'}
                        disabled={isBusy || locked}
                        loading={isDeleting}
                        size="icon-xs"
                        title={
                          isPermanentAdmin
                            ? 'The owner cannot leave their personal organization'
                            : isLastAdmin
                              ? 'This organization needs at least one admin'
                              : isCurrentUser
                                ? 'Leave organization'
                                : 'Remove member'
                        }
                        variant="ghost"
                        onClick={() => remove(member)}
                      >
                        <TrashIcon className="size-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Frame>
    </div>
  )
}

// ── Invite dialog ───────────────────────────────────────────────────

function InviteButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlusIcon />
        Invite member
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              Generate a link to invite someone to this organization. Anyone with the
              link can join as a member. The link expires in 7 days.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <InviteDialogBody />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  )
}

// Lives in its own component so closing the dialog unmounts it (base-ui's
// Portal is not kept mounted), resetting the generated link, the copied
// flag, and the ErrorBoundary — no manual reset-on-close plumbing needed.
// The submit Button shows its pending state automatically via useFormStatus;
// errors thrown by createInvite are caught by the ErrorBoundary, and the
// `below` position keeps the form visible so the user can retry.
function InviteDialogBody() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const [inviteUrl, generateAction] = useActionState(async () => {
    const { invitationId } = await createInvite({ orgId: currentOrgId })
    return `${window.location.origin}/invite/${invitationId}`
  }, null as string | null)
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (inviteUrl) {
    return (
      <>
        <div className="flex gap-2">
          <Input
            readOnly
            value={inviteUrl}
            className="w-full font-mono text-xs"
            onClick={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" size="icon" aria-label="Copy invite link" onClick={() => void copy()}>
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Share this link with the person you want to invite. They will need to sign in first.
        </p>
      </>
    )
  }

  return (
    <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="mt-3 text-sm text-destructive" />}>
      <form action={generateAction}>
        <Button type="submit" className="w-full">
          <LinkIcon />
          Generate invite link
        </Button>
      </form>
    </ErrorBoundary>
  )
}

// ── Accept invite (used by the standalone /invite/:invitationId page) ──
// acceptInvite redirects to the org's events page (/org/:orgId) —
// client-side navigation, no reload. Already-members just navigate there
// directly. Errors thrown by the action are caught by the ErrorBoundary;
// the form's submit Button shows its pending state automatically via
// useFormStatus.

export function AcceptInviteButton({
  invitationId,
  orgId,
  reviewFormId,
  alreadyMember,
}: {
  invitationId: string
  orgId: string
  reviewFormId?: string | null
  alreadyMember: boolean
}) {
  return (
    <ErrorBoundary
      below
      fallback={
        <div className="mt-3 flex flex-col items-center gap-2">
          <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
          <ErrorBoundary.ResetButton className="cursor-pointer text-sm text-destructive underline">
            Try again
          </ErrorBoundary.ResetButton>
        </div>
      }
    >
      <form
        className="w-full"
        action={async () => {
          if (alreadyMember) {
            // Fire-and-forget navigation (awaiting a navigation commit
            // inside a form action can deadlock the transition).
            router.push(reviewFormId ? `/review/${reviewFormId}` : `/org/${orgId}`)
            return
          }
          await acceptInvite({ invitationId })
        }}
      >
        <Button type="submit" className="w-full">
          {alreadyMember ? 'Open dashboard' : 'Accept invitation'}
        </Button>
      </form>
    </ErrorBoundary>
  )
}
