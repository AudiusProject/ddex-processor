import { DDEXRelease } from './parseDelivery'

export { assetRepo } from './db/assetRepo'
export { isClearedRepo } from './db/isClearedRepo'
export { releaseRepo } from './db/releaseRepo'
export { s3markerRepo } from './db/s3markerRepo'
export { userRepo } from './db/userRepo'
export { xmlRepo } from './db/xmlRepo'

export type XmlRow = {
  source: string
  xmlUrl: string
  messageTimestamp: string
  createdAt: string
}

export type UserRow = {
  apiKey: string
  id: string
  handle: string
  name: string
  createdAt: Date
  password?: string
}

export enum ReleaseProcessingStatus {
  Blocked = 'Blocked',
  PublishPending = 'PublishPending',
  Published = 'Published',
  Failed = 'Failed',
  DeletePending = 'DeletePending',
  Deleted = 'Deleted',
}

export type ReleaseRow = DDEXRelease & {
  source: string
  key: string
  xmlUrl: string
  messageTimestamp: string
  status: ReleaseProcessingStatus
  createdAt: string
  numCleared: number
  numNotCleared: number
  prependArtist: string
  entityType?: 'track' | 'album'
  entityId?: string
  blockHash?: string
  blockNumber?: number
  publishedAt?: string
  lastPublishError: string
  publishErrorCount: number
}

export type S3MarkerRow = {
  bucket: string
  marker: string
}

export type IsClearedRow = {
  releaseId: string
  trackId: string
  isMatched: boolean
  isCleared: boolean
}
