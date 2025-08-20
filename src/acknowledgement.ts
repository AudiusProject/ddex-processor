import * as cheerio from 'cheerio'
import { DDEXRelease } from './parseDelivery'
import { sources } from './sources'

export type AcknowledgementResult = {
  source: string
  xmlUrl: string
  messageTimestamp: string
  success: boolean
  error?: string
  releaseCount?: number
  releases?: DDEXRelease[]
}

// Bearer token cache with 1-hour expiration
type TokenCacheEntry = {
  token: string
  expiresAt: number
}

// Promise-based cache to prevent race conditions
const tokenCache: Map<string, TokenCacheEntry> = new Map()
const tokenPromises: Map<string, Promise<string>> = new Map()

function getCachedToken(source: string): string | null {
  const entry = tokenCache.get(source)
  if (!entry) return null
  
  if (Date.now() > entry.expiresAt) {
    // Token expired, remove from cache
    tokenCache.delete(source)
    return null
  }
  
  return entry.token
}

function setCachedToken(source: string, token: string): void {
  const expiresAt = Date.now() + (60 * 60 * 1000) // 1 hour from now
  tokenCache.set(source, { token, expiresAt })
}

async function getOrFetchToken(source: string, acknowledgementServerUsername: string, acknowledgementServerPassword: string): Promise<string> {
  // Check cache first
  const cachedToken = getCachedToken(source)
  if (cachedToken) {
    console.log('Using cached bearer token')
    return cachedToken
  }

  // Check if there's already a token request in progress
  const existingPromise = tokenPromises.get(source)
  if (existingPromise) {
    console.log('Waiting for existing token request to complete...')
    return existingPromise
  }

  // Start a new token request
  const tokenPromise = fetchNewToken(source, acknowledgementServerUsername, acknowledgementServerPassword)
  tokenPromises.set(source, tokenPromise)

  try {
    const token = await tokenPromise
    return token
  } finally {
    // Clean up the promise from the map
    tokenPromises.delete(source)
  }
}

async function fetchNewToken(source: string, acknowledgementServerUsername: string, acknowledgementServerPassword: string): Promise<string> {
  const DPID = 'PADPIDA202401120D9'
  const tokenUrl = `https://delivery-gw.smecde.com/gateway/token/${DPID}`
  const basicAuth = Buffer.from(`${acknowledgementServerUsername}:${acknowledgementServerPassword}`).toString('base64')

  console.log('Requesting bearer token from:', tokenUrl)
  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/json'
    }
  })

  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenResponse.statusText}`)
  }

  const bearerToken = await tokenResponse.text()
  console.log('Bearer token obtained')
  
  // Cache the token for 1 hour
  setCachedToken(source, bearerToken)
  
  return bearerToken
}

function getSourcePartyName(source: string): string {
  switch (source) {
    case 'sme':
      return 'Sony Music Entertainment'
    default:
      return source
  }
}

function generateAcknowledgementXml({
  source,
  messageId,
  releases,
  isSuccess,
  error,
  recipientPartyId,
}: {
  source: string,
  messageId: string,
  releases: DDEXRelease[],
  isSuccess: boolean,
  error?: string,
  recipientPartyId?: string
}): string {
  const $ = cheerio.load('', { xmlMode: true })
  
  // Create root element
  const root = $('<ns3:AcknowledgementMessage></ns3:AcknowledgementMessage>')
  root.attr('xmlns:xs', 'http://www.w3.org/2001/XMLSchema-instance')
  root.attr('xmlns:ns3', 'http://ddex.net/xml/ern-c-sftp/18')
  root.attr('AvsVersionId', '4')
  
  // MessageHeader
  const messageHeader = $('<MessageHeader></MessageHeader>')
  messageHeader.append($(`<MessageId>${messageId}</MessageId>`))
  
  // MessageSender (Audius as the distributor)
  const messageSender = $('<MessageSender></MessageSender>')
  messageSender.append($('<PartyId>PADPIDA202401120D9</PartyId>'))
  const senderPartyName = $('<PartyName></PartyName>')
  senderPartyName.append($('<FullName>Tiki Labs, Inc.</FullName>'))
  messageSender.append(senderPartyName)
  messageHeader.append(messageSender)
  
  // MessageRecipient (Source)
  const messageRecipient = $('<MessageRecipient></MessageRecipient>')
  const resolvedRecipient = recipientPartyId || (source === 'sme' ? 'PADPIDA2007040502I' : source.toUpperCase())
  messageRecipient.append($(`<PartyId>${resolvedRecipient}</PartyId>`))
  const recipientPartyName = $('<PartyName></PartyName>')
  recipientPartyName.append($(`<FullName>${getSourcePartyName(source)}</FullName>`))
  messageRecipient.append(recipientPartyName)
  messageHeader.append(messageRecipient)
  
  // MessageCreatedDateTime
  const currentTime = new Date().toISOString()
  messageHeader.append($(`<MessageCreatedDateTime>${currentTime}</MessageCreatedDateTime>`))
  
  root.append(messageHeader)
  
  // If we have releases, create ReleaseStatus entries for each
  if (releases.length > 0) {
    for (const release of releases) {
      const releaseStatus = $('<ReleaseStatus></ReleaseStatus>')
      
      // ReleaseId - prefer GRid (especially for SME), fallback to other IDs
      const releaseId = $('<ReleaseId></ReleaseId>')
      if (release.releaseIds.grid) {
        releaseId.append($(`<GRid>${release.releaseIds.grid}</GRid>`))
      } else if (release.releaseIds.catalog_number) {
        releaseId.append($(`<CatalogNumber>${release.releaseIds.catalog_number}</CatalogNumber>`))
      } else if (release.releaseIds.icpn) {
        releaseId.append($(`<ICPN>${release.releaseIds.icpn}</ICPN>`))
      } else if (release.releaseIds.proprietary_id) {
        releaseId.append($(`<ProprietaryId>${release.releaseIds.proprietary_id}</ProprietaryId>`))
      } else {
        // Use the ref as fallback
        releaseId.append($(`<ProprietaryId>${release.ref}</ProprietaryId>`))
      }
      releaseStatus.append(releaseId)
      
      // ReleaseStatus - different values for success vs error
      if (isSuccess) {
        releaseStatus.append($('<ReleaseStatus>SuccessfullyIngestedByReleaseDistributor</ReleaseStatus>'))
        const acknowledgement = $('<Acknowledgement></Acknowledgement>')
        acknowledgement.append($('<MessageType>NewReleaseMessage</MessageType>'))
        acknowledgement.append($(`<MessageId>${messageId}</MessageId>`))
        const messageStatus = $('<MessageStatus></MessageStatus>')
        messageStatus.append($('<Status>FileOK</Status>'))
        acknowledgement.append(messageStatus)
        releaseStatus.append(acknowledgement)
      } else {
        releaseStatus.append($('<ReleaseStatus>ProcessingErrorAtReleaseDistributor</ReleaseStatus>'))
        const acknowledgement = $('<Acknowledgement></Acknowledgement>')
        acknowledgement.append($('<MessageType>NewReleaseMessage</MessageType>'))
        acknowledgement.append($(`<MessageId>${messageId}</MessageId>`))
        const messageStatus = $('<MessageStatus></MessageStatus>')
        messageStatus.append($('<Status>ResourceCorrupt</Status>'))
        if (error) {
          messageStatus.append($(`<StatusMessage>${error}</StatusMessage>`))
        }
        acknowledgement.append(messageStatus)
        releaseStatus.append(acknowledgement)
      }
      
      root.append(releaseStatus)
    }
  } else {
    // No releases - create a general acknowledgement
    const generalAcknowledgement = $('<Acknowledgement></Acknowledgement>')
    generalAcknowledgement.append($('<MessageType>NewReleaseMessage</MessageType>'))
    generalAcknowledgement.append($(`<MessageId>${messageId}</MessageId>`))
    
    const messageStatus = $('<MessageStatus></MessageStatus>')
    if (isSuccess) {
      messageStatus.append($('<Status>FileOK</Status>'))
    } else {
      messageStatus.append($('<Status>ResourceCorrupt</Status>'))
      
      if (error) {
        messageStatus.append($(`<StatusMessage>${error}</StatusMessage>`))
      }
    }
    
    generalAcknowledgement.append(messageStatus)
    root.append(generalAcknowledgement)
  }
  
  // Add XML declaration and return
  const xmlDeclaration = '<?xml version="1.0"?>\n'
  return xmlDeclaration + $.html(root)
}

async function sendAcknowledgement(source: string, xml: string) {
  const sourceConfig = sources.findByName(source)
  if (!sourceConfig) {
    console.error('No source config found for', source)
    return
  }

  const { acknowledgementServerUsername, acknowledgementServerPassword } = sourceConfig
  
  if (!acknowledgementServerUsername || !acknowledgementServerPassword) {
    console.error('Missing acknowledgement server credentials for source', source)
    return
  }

  const DPID = 'PADPIDA202401120D9'
  
  try {
    // Step 1: Generate Gateway Bearer Token (only if not cached)
    const bearerToken = await getOrFetchToken(source, acknowledgementServerUsername, acknowledgementServerPassword)
    console.log('Got bearerToken', bearerToken)

    // Step 2: Post the XML using the bearer token
    const statusUrl = `https://delivery-gw.smecde.com/gateway/ddex/ern/post/status/${DPID}`
    console.log('Posting acknowledgement XML to:', statusUrl)
    
    const statusResponse = await fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/xml'
      },
      body: xml
    })
    
    if (!statusResponse.ok) {
      const errText = await statusResponse.text().catch(() => '')
      throw new Error(`Status post failed: ${statusResponse.status} ${statusResponse.statusText} ${errText ? '- ' + errText : ''}`)
    }
    
    console.log('Acknowledgement XML posted successfully')
  } catch (error) {
    console.error('Failed to send acknowledgement:', error)
    throw error
  }
}

export async function acknowledgeReleaseSuccess({
  source,
  xmlUrl,
  messageId,
  messageTimestamp,
  releases,
}: {
  source: string
  xmlUrl: string
  messageId: string
  messageTimestamp: string
  releases: DDEXRelease[]
}) {
  const result: AcknowledgementResult = {
    source,
    xmlUrl,
    messageTimestamp,
    success: true,
    releaseCount: releases.length,
    releases
  }
  
  console.log('\nPreparing to send success acknowledgement:', {
    source,
    xmlUrl,
    messageTimestamp,
    releaseCount: releases.length,
    releases: releases.map(r => ({
      ref: r.ref,
      title: r.title,
      artists: r.artists.map(a => a.name),
      problems: r.problems,
      dealCount: r.deals.length
    }))
  })
  
  // Generate and log acknowledgement XML
  const acknowledgementXml = generateAcknowledgementXml(
    {
      source,
      messageId,
      releases,
      isSuccess: true,
      recipientPartyId: source === 'sme' ? 'PADPIDA2007040502I' : undefined
    }
  )
  console.log(acknowledgementXml)
  
  // Send acknowledgement message to source
  try {
    await sendAcknowledgement(source, acknowledgementXml)
  } catch (error) {
    console.error('Failed to send success acknowledgement:', error)
    // Don't throw - acknowledgement failure shouldn't stop the main flow
  }
  
  return result
}

export async function acknowledgeReleaseFailure({
  source,
  xmlUrl,
  messageId,
  messageTimestamp,
  error,
  releases,
}: {
  source: string
  xmlUrl: string
  messageId: string
  messageTimestamp: string
  error: string | Error
  releases?: DDEXRelease[]
}) {
  const errorMessage = error instanceof Error ? error.message : error
  
  const result: AcknowledgementResult = {
    source,
    xmlUrl,
    messageTimestamp,
    success: false,
    error: errorMessage
  }
  
  console.log('\nPreparing to send failure acknowledgement:', {
    source,
    xmlUrl,
    messageTimestamp,
    error: errorMessage
  })
  
  // Generate and log acknowledgement XML for failure
  const acknowledgementXml = generateAcknowledgementXml(
    {
      source,
      messageId,
      releases: releases || [], // Include releases when available
      isSuccess: false,
      error: errorMessage,
      recipientPartyId: source === 'sme' ? 'PADPIDA2007040502I' : undefined
    }
  )
  console.log(acknowledgementXml)
  
  // Send acknowledgement message to source
  try {
    await sendAcknowledgement(source, acknowledgementXml)
  } catch (error) {
    console.error('Failed to send failure acknowledgement:', error)
    // Don't throw - acknowledgement failure shouldn't stop the main flow
  }
  
  return result
} 