// Pure tests for Phase 4 file versioning, ZIP selection, and public approval.
import { describe, expect, test } from 'vitest'
import {
  isPublicContentEligible,
  latestTaskFileVersions,
  selectLatestZipEntries,
  taskFileSlotKey,
} from './content-management.ts'

const files = [
  {
    id: 'slides-v1',
    taskAssignmentId: 'assignment-priya',
    fieldName: 'slides',
    fileName: 'slides.pdf',
    createdAt: 100,
    speakerName: 'Priya Raman',
    sessionTitle: 'Taming 40-Minute CI',
  },
  {
    id: 'slides-v2',
    taskAssignmentId: 'assignment-priya',
    fieldName: 'slides',
    fileName: 'slides.pdf',
    createdAt: 200,
    speakerName: 'Priya Raman',
    sessionTitle: 'Taming 40-Minute CI',
  },
  {
    id: 'headshot-v1',
    taskAssignmentId: 'assignment-priya',
    fieldName: 'speaker.headshot',
    fileName: 'headshot.png',
    createdAt: 150,
    speakerName: 'Priya Raman',
    sessionTitle: null,
  },
  {
    id: 'slides-marcus',
    taskAssignmentId: 'assignment-marcus',
    fieldName: 'slides',
    fileName: 'slides.pdf',
    createdAt: 300,
    speakerName: 'Marcus Okafor',
    sessionTitle: 'Lightning: Agents in Production Q&A',
  },
]

describe('task file versions', () => {
  test('orders immutable versions newest first and marks one current file per slot', () => {
    expect(latestTaskFileVersions(files)).toMatchInlineSnapshot(`
      [
        {
          "currentFileId": "slides-marcus",
          "fieldName": "slides",
          "slotKey": "assignment-marcus:slides",
          "taskAssignmentId": "assignment-marcus",
          "versions": [
            {
              "createdAt": 300,
              "fieldName": "slides",
              "fileName": "slides.pdf",
              "id": "slides-marcus",
              "sessionTitle": "Lightning: Agents in Production Q&A",
              "speakerName": "Marcus Okafor",
              "taskAssignmentId": "assignment-marcus",
            },
          ],
        },
        {
          "currentFileId": "slides-v2",
          "fieldName": "slides",
          "slotKey": "assignment-priya:slides",
          "taskAssignmentId": "assignment-priya",
          "versions": [
            {
              "createdAt": 200,
              "fieldName": "slides",
              "fileName": "slides.pdf",
              "id": "slides-v2",
              "sessionTitle": "Taming 40-Minute CI",
              "speakerName": "Priya Raman",
              "taskAssignmentId": "assignment-priya",
            },
            {
              "createdAt": 100,
              "fieldName": "slides",
              "fileName": "slides.pdf",
              "id": "slides-v1",
              "sessionTitle": "Taming 40-Minute CI",
              "speakerName": "Priya Raman",
              "taskAssignmentId": "assignment-priya",
            },
          ],
        },
        {
          "currentFileId": "headshot-v1",
          "fieldName": "speaker.headshot",
          "slotKey": "assignment-priya:speaker.headshot",
          "taskAssignmentId": "assignment-priya",
          "versions": [
            {
              "createdAt": 150,
              "fieldName": "speaker.headshot",
              "fileName": "headshot.png",
              "id": "headshot-v1",
              "sessionTitle": null,
              "speakerName": "Priya Raman",
              "taskAssignmentId": "assignment-priya",
            },
          ],
        },
      ]
    `)
  })

  test('selects only the latest version from explicitly selected slots for ZIP output', () => {
    const selected = new Set([
      taskFileSlotKey('assignment-priya', 'slides'),
      taskFileSlotKey('assignment-marcus', 'slides'),
    ])
    expect(selectLatestZipEntries(files, selected)).toMatchInlineSnapshot(`
      [
        {
          "archivePath": "Lightning Agents in Production QA/Marcus Okafor/slides/slides.pdf",
          "fileId": "slides-marcus",
        },
        {
          "archivePath": "Taming 40-Minute CI/Priya Raman/slides/slides.pdf",
          "fileId": "slides-v2",
        },
      ]
    `)
  })
})

describe('public content approval', () => {
  test('requires accepted and public content', () => {
    expect([
      isPublicContentEligible({ status: 'ACCEPTED', visibility: 'PUBLIC' }),
      isPublicContentEligible({ status: 'ACCEPTED', visibility: 'PRIVATE' }),
      isPublicContentEligible({ status: 'PENDING', visibility: 'PUBLIC' }),
    ]).toEqual([true, false, false])
  })
})
