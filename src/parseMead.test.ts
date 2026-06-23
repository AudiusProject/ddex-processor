import { beforeAll, expect, test } from 'vitest'

import {
  ArtistProfileUpdateStatus,
  artistProfileUpdateRepo,
  userRepo,
} from './db'
import { pgMigrate } from './db/migrations'
import { sql } from './db/sql'
import {
  DDEXArtistProfileUpdate,
  parseDdexXml,
  parseDdexXmlFile,
} from './parseDelivery'
import { sources } from './sources'

beforeAll(async () => {
  await pgMigrate()
  sources.load('./fixtures/sources.test.json')
})

test('parses MEAD artist profile updates', async () => {
  await sql`
    delete from artist_profile_updates
    where "xmlUrl" = ${'fixtures/mead_artist_update.xml'}
  `
  await userRepo.upsert({
    apiKey: 'crudTestKey',
    id: 'djtheo',
    handle: 'djtheo',
    name: 'DJ Theo',
    createdAt: new Date(),
  })

  const updates = (await parseDdexXmlFile(
    'crudTest',
    'fixtures/mead_artist_update.xml'
  )) as DDEXArtistProfileUpdate[]

  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({
    partyRef: 'P1',
    artistName: 'DJ Theo',
    audiusUser: 'djtheo',
    displayName: 'DJ Theo Official',
    bio: 'Oakland producer and DJ building vivid left-field dance records.',
    profilePicture: {
      ref: 'mead-image-1',
      filePath: 'resources/',
      fileName: 'Image_001_001.jpg',
    },
    problems: [],
  })

  const key = artistProfileUpdateRepo.chooseKey(
    'crudTest',
    'fixtures/mead_artist_update.xml',
    updates[0]
  )
  const row = await artistProfileUpdateRepo.get(key)
  expect(row).toMatchObject({
    key,
    status: ArtistProfileUpdateStatus.PublishPending,
    audiusUser: 'djtheo',
    displayName: 'DJ Theo Official',
  })
})

test('MEAD sender example: target an authorized artist by Audius user id', async () => {
  await userRepo.upsert({
    apiKey: 'crudTestKey',
    id: 'artist-user-1',
    handle: 'artistone',
    name: 'Artist One',
    createdAt: new Date(),
  })

  const xmlUrl = 'fixtures/sender_example_user_id_mead.xml'
  await sql`delete from artist_profile_updates where "xmlUrl" = ${xmlUrl}`

  const meadXml = `<?xml version="1.0" encoding="UTF-8"?>
<mead:MeadMessage xmlns:mead="http://ddex.net/xml/mead/10">
  <MessageHeader>
    <MessageId>sender-example-user-id</MessageId>
    <MessageCreatedDateTime>2026-06-22T13:00:00Z</MessageCreatedDateTime>
  </MessageHeader>
  <PartyInformationList>
    <PartyInformation>
      <PartySummary>
        <PartyReference>P-ARTIST-1</PartyReference>
        <ProprietaryId Namespace="AudiusUserId">
          <Identifier>artist-user-1</Identifier>
        </ProprietaryId>
        <PartyName>
          <FullName>
            <Name>Artist One</Name>
          </FullName>
        </PartyName>
      </PartySummary>
      <Pseudonym>
        <Name>
          <FullName>
            <Name>Artist One Display</Name>
          </FullName>
        </Name>
        <IsOfficial>true</IsOfficial>
      </Pseudonym>
      <Biography>
        <Text>Short artist bio from a standalone MEAD update.</Text>
      </Biography>
      <Image>
        <ResourceReference>IMG-PROFILE</ResourceReference>
        <File>
          <URI>images/profile.jpg</URI>
        </File>
        <ImageType UserDefinedValue="ProfilePicture" />
      </Image>
    </PartyInformation>
  </PartyInformationList>
</mead:MeadMessage>`

  const updates = (await parseDdexXml(
    'crudTest',
    xmlUrl,
    meadXml
  )) as DDEXArtistProfileUpdate[]

  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({
    partyRef: 'P-ARTIST-1',
    artistName: 'Artist One',
    audiusUser: 'artist-user-1',
    displayName: 'Artist One Display',
    bio: 'Short artist bio from a standalone MEAD update.',
    profilePicture: {
      ref: 'IMG-PROFILE',
      filePath: 'images/',
      fileName: 'profile.jpg',
    },
    problems: [],
  })

  const key = artistProfileUpdateRepo.chooseKey('crudTest', xmlUrl, updates[0])
  await expect(artistProfileUpdateRepo.get(key)).resolves.toMatchObject({
    status: ArtistProfileUpdateStatus.PublishPending,
    audiusUser: 'artist-user-1',
  })
})

test('MEAD sender example: send a feed entry and target by authorized Audius handle', async () => {
  await userRepo.upsert({
    apiKey: 'crudTestKey',
    id: 'artist-user-2',
    handle: 'artisttwo',
    name: 'Artist Two',
    createdAt: new Date(),
  })

  const xmlUrl = 'fixtures/sender_example_feed_handle_mead.xml'
  await sql`delete from artist_profile_updates where "xmlUrl" = ${xmlUrl}`

  const meadFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<Feed xmlns="http://ddex.net/xml/mead/10">
  <MessageHeader>
    <MessageId>sender-example-feed-handle</MessageId>
    <MessageCreatedDateTime>2026-06-22T14:00:00Z</MessageCreatedDateTime>
  </MessageHeader>
  <Entry>
    <Party>
      <PartyReference>P-ARTIST-2</PartyReference>
      <ProprietaryId Namespace="AudiusHandle">
        <Identifier>artisttwo</Identifier>
      </ProprietaryId>
      <PartyName>
        <FullName>
          <Name>Artist Two</Name>
        </FullName>
      </PartyName>
    </Party>
    <PartyInformation>
      <DisplayName>Artist Two Deluxe</DisplayName>
      <Biography>
        <Text>Bio update sent as an entry in a larger MEAD feed.</Text>
      </Biography>
      <Image>
        <File>
          <URI>images/artist-two-profile.png</URI>
        </File>
        <ImageType UserDefinedValue="ArtistPhoto" />
      </Image>
      <Image>
        <File>
          <URI>images/artist-two-banner.jpg</URI>
        </File>
        <ImageType UserDefinedValue="ProfileBanner" />
      </Image>
    </PartyInformation>
  </Entry>
</Feed>`

  const updates = (await parseDdexXml(
    'crudTest',
    xmlUrl,
    meadFeedXml
  )) as DDEXArtistProfileUpdate[]

  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({
    partyRef: 'P-ARTIST-2',
    artistName: 'Artist Two',
    artistHandle: 'artisttwo',
    audiusUser: 'artist-user-2',
    displayName: 'Artist Two Deluxe',
    bio: 'Bio update sent as an entry in a larger MEAD feed.',
    profilePicture: {
      filePath: 'images/',
      fileName: 'artist-two-profile.png',
    },
    coverArt: {
      filePath: 'images/',
      fileName: 'artist-two-banner.jpg',
    },
    problems: [],
  })
})

test('MEAD sender example: unmatched artists are blocked until the source is authorized', async () => {
  const xmlUrl = 'fixtures/sender_example_unmatched_mead.xml'
  await sql`delete from artist_profile_updates where "xmlUrl" = ${xmlUrl}`

  const meadXml = `<?xml version="1.0" encoding="UTF-8"?>
<MeadMessage>
  <MessageHeader>
    <MessageId>sender-example-unmatched</MessageId>
    <MessageCreatedDateTime>2026-06-22T15:00:00Z</MessageCreatedDateTime>
  </MessageHeader>
  <PartyInformationList>
    <PartyInformation>
      <PartySummary>
        <PartyReference>P-UNKNOWN</PartyReference>
        <PartyName>
          <FullName>
            <Name>Unmatched Artist</Name>
          </FullName>
        </PartyName>
      </PartySummary>
      <Biography>
        <Text>This should not publish until the artist grants the source app.</Text>
      </Biography>
    </PartyInformation>
  </PartyInformationList>
</MeadMessage>`

  const updates = (await parseDdexXml(
    'crudTest',
    xmlUrl,
    meadXml
  )) as DDEXArtistProfileUpdate[]

  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({
    partyRef: 'P-UNKNOWN',
    artistName: 'Unmatched Artist',
    bio: 'This should not publish until the artist grants the source app.',
    problems: ['NoAudiusUser'],
  })

  const key = artistProfileUpdateRepo.chooseKey('crudTest', xmlUrl, updates[0])
  await expect(artistProfileUpdateRepo.get(key)).resolves.toMatchObject({
    status: ArtistProfileUpdateStatus.Blocked,
    problems: ['NoAudiusUser'],
  })
})
