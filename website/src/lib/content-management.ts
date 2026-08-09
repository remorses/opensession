// Pure Phase 4 content-management rules shared by loaders, ZIP export, and tests.
// File versions are immutable rows. Current state is always derived by slot and time.

export type TaskFileVersion = {
  id: string
  taskAssignmentId: string | null
  fieldName: string | null
  fileName: string
  createdAt: number
  speakerName?: string | null
  sessionTitle?: string | null
}

export type TaskFileSlot<T extends TaskFileVersion = TaskFileVersion> = {
  slotKey: string
  taskAssignmentId: string
  fieldName: string
  currentFileId: string
  versions: T[]
}

export function taskFileSlotKey(taskAssignmentId: string, fieldName: string): string {
  return `${taskAssignmentId}:${fieldName}`
}

export function latestTaskFileVersions<T extends TaskFileVersion>(files: readonly T[]): TaskFileSlot<T>[] {
  const slots = new Map<string, T[]>()
  for (const file of files) {
    if (!file.taskAssignmentId || !file.fieldName) continue
    const key = taskFileSlotKey(file.taskAssignmentId, file.fieldName)
    const versions = slots.get(key)
    if (versions) versions.push(file)
    else slots.set(key, [file])
  }

  return [...slots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slotKey, versions]) => {
      const ordered = [...versions].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      const current = ordered[0]!
      return {
        slotKey,
        taskAssignmentId: current.taskAssignmentId!,
        fieldName: current.fieldName!,
        currentFileId: current.id,
        versions: ordered,
      }
    })
}

export function selectLatestZipEntries<T extends TaskFileVersion>(
  files: readonly T[],
  selectedSlots: ReadonlySet<string>,
): Array<{ fileId: string; archivePath: string }> {
  return latestTaskFileVersions(files)
    .filter((slot) => selectedSlots.has(slot.slotKey))
    .map((slot) => {
      const file = slot.versions[0]!
      const session = archiveSegment(file.sessionTitle || 'Speaker files')
      const speaker = archiveSegment(file.speakerName || 'Speaker')
      const field = archiveSegment(slot.fieldName)
      return {
        fileId: file.id,
        archivePath: `${session}/${speaker}/${field}/${archiveSegment(file.fileName)}`,
      }
    })
}

function archiveSegment(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[^\w .()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'file'
}

export function isPublicContentEligible(session: {
  status: string
  visibility: string
}): boolean {
  return session.status === 'ACCEPTED' && session.visibility === 'PUBLIC'
}
