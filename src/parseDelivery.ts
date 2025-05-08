import { Genre } from '@audius/sdk'
import * as cheerio from 'cheerio'
import decompress from 'decompress'
import type { Element } from 'domhandler'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseRepo, userRepo, xmlRepo } from './db'
import { sources } from './sources'
import { lowerAscii, omitEmpty } from './util'

type CH = cheerio.Cheerio<Element>

export type DDEXReleaseIds = {
  party_id?: string
  catalog_number?: string
  icpn?: string
  grid?: string
  isan?: string
  isbn?: string
  ismn?: string
  isrc?: string
  issn?: string
  istc?: string
  iswc?: string
  mwli?: string
  sici?: string
  proprietary_id?: string
}

export type DDEXPurgeRelease = {
  releaseIds: DDEXReleaseIds
}

export type DDEXRelease = {
  ref: string
  title: string
  subTitle?: string
  genre: string
  subGenre: string
  releaseDate: string
  releaseType: string
  releaseIds: DDEXReleaseIds

  isMainRelease: boolean
  audiusGenre?: Genre
  audiusUser?: string

  problems: string[]
  soundRecordings: DDEXSoundRecording[]
  images: DDEXResource[]
  deals: AudiusSupportedDeal[]
} & ReleaseAndSoundRecordingSharedFields

type ReleaseAndSoundRecordingSharedFields = {
  copyrightLine?: CopyrightPair
  producerCopyrightLine?: CopyrightPair
  parentalWarningType?: string
  artists: DDEXContributor[]
  contributors: DDEXContributor[]
  indirectContributors: DDEXContributor[]
  labelName: string
}

export type CopyrightPair = {
  text: string
  year: string
}

export type DDEXContributor = {
  name: string
  role: string
}

export type DDEXResource = {
  ref: string
  filePath: string
  fileName: string
}

export type DDEXSoundRecording = {
  isrc?: string
  title: string
  subTitle: string
  releaseDate: string
  genre: string
  subGenre: string
  rightsController?: {
    name: string
    roles: string[]
    // rightShareUnknown: string
  }
  duration?: number
  previewStartSeconds?: number

  audiusGenre?: Genre
} & DDEXResource &
  ReleaseAndSoundRecordingSharedFields

type DealFields = {
  validityStartDate: string
  validityEndDate?: string
  forStream: boolean
  forDownload: boolean
}

export type DealFree = DealFields & {
  audiusDealType: 'Free'
}

export type DealPayGated = DealFields & {
  audiusDealType: 'PayGated'
  priceUsd?: number
}

export type DealFollowGated = DealFields & {
  audiusDealType: 'FollowGated'
}

export type DealTipGated = DealFields & {
  audiusDealType: 'TipGated'
}

export type DealEthGated = DealFields & {
  audiusDealType: 'NFTGated'
  chain: 'eth'
  address: string
  standard?: string
  name: string
  slug?: string
  imageUrl?: string
  externalLink?: string
}

export type DealSolGated = DealFields & {
  audiusDealType: 'NFTGated'
  chain: 'sol'
  address: string
  name: string
  imageUrl?: string
  externalLink?: string
}

export type AudiusSupportedDeal =
  | DealFree
  | DealPayGated
  | DealFollowGated
  | DealTipGated
  | DealEthGated
  | DealSolGated

export async function parseDelivery(source: string, maybeZip: string) {
  if (maybeZip.endsWith('.zip')) {
    const tempDir = await mkdtemp(join(tmpdir(), 'ddex-'))
    await decompress(maybeZip, tempDir)
    return await processDeliveryDir(source, tempDir)
    // await rm(tempDir, { recursive: true })
  } else if (maybeZip.endsWith('.xml')) {
    return await parseDdexXmlFile(source, maybeZip)
  } else {
    return await processDeliveryDir(source, maybeZip)
  }
}

// recursively find + parse xml files in a dir
export async function processDeliveryDir(source: string, dir: string) {
  const files = await readdir(dir, { recursive: true })

  const work = files
    .filter((f) => f.toLowerCase().endsWith('.xml'))
    .map((f) => join(dir, f))
    .map((f) => parseDdexXmlFile(source, f))

  return Promise.all(work)
}

// read xml from disk + parse
export async function parseDdexXmlFile(source: string, xmlUrl: string) {
  const xmlText = await readFile(xmlUrl, 'utf8')
  return parseDdexXml(source, xmlUrl, xmlText)
}

// actually parse ddex xml
export async function parseDdexXml(
  source: string,
  xmlUrl: string,
  xmlText: string
) {
  const $ = cheerio.load(xmlText, { xmlMode: true })

  const messageTimestamp = $('MessageCreatedDateTime').first().text()
  const rawTagName = $.root().children().first().prop('name')
  const tagName = [
    'NewReleaseMessage',
    'PurgeReleaseMessage',
    'ManifestMessage',
  ].find((n) => rawTagName.includes(n))
  const isUpdate = $('UpdateIndicator').text() == 'UpdateMessage'

  // todo: would be nice to skip this on reParse
  await xmlRepo.upsert({
    source,
    xmlUrl,
    messageTimestamp,
  })

  if (tagName == 'ManifestMessage') {
    // don't care about batch.
  } else if (tagName == 'PurgeReleaseMessage') {
    // mark release rows as DeletePending
    const { releaseIds } = parsePurgeXml($)
    await releaseRepo.markForDelete(
      source,
      xmlUrl,
      messageTimestamp,
      releaseIds
    )
  } else if (tagName == 'NewReleaseMessage') {
    // create or replace this release in db
    const releases = await parseReleaseXml(source, $)
    for (const release of releases) {
      await releaseRepo.upsert(source, xmlUrl, messageTimestamp, release)
    }
    return releases
  } else {
    console.log('unknown tagname', tagName)
  }
}

//
// parseRelease
//
async function parseReleaseXml(source: string, $: cheerio.CheerioAPI) {
  function toTexts($doc: CH) {
    return $doc.map((_, el) => $(el).text()).get()
  }

  function cline($el: CH) {
    const year = toText($el.find('CLine > Year'))
    const text = toText($el.find('CLine > CLineText'))
    if (year && text) return { year, text }
  }

  function pline($el: CH) {
    const year = toText($el.find('PLine > Year'))
    const text = toText($el.find('PLine > PLineText'))
    if (year && text) return { year, text }
  }

  function parseGenres($el: CH): [genre: string, subGenre: string] {
    const genres = toTexts($el.find('GenreText'))
    let subGenres = toTexts($el.find('SubGenre'))
    if (!subGenres.length) {
      subGenres = genres.slice(1)
    }
    return [genres[0] || '', subGenres[0] || '']
  }

  function parseContributor(
    tagName:
      | 'DisplayArtist'
      | 'ResourceContributor'
      | 'IndirectResourceContributor',
    $el: CH
  ): DDEXContributor[] {
    const roleTagName =
      tagName == 'DisplayArtist' ? 'ArtistRole' : `${tagName}Role`

    return $el
      .find(tagName)
      .toArray()
      .map((el) => {
        const roleTag = $(el).find(roleTagName).first()
        return {
          name: toText($(el).find('FullName')),
          role: roleTag.attr('UserDefinedValue') || roleTag.text(),
        }
      })
  }

  //
  // parse deals
  //
  const releaseDeals: Record<string, AudiusSupportedDeal[]> = {}
  $('ReleaseDeal').each((_, el) => {
    const $el = $(el)
    const ref = $el.find('DealReleaseReference').text()
    $el.find('DealTerms').each((_, el) => {
      const $el = $(el)

      const cmt = $el.find('CommercialModelType')
      const commercialModelType = cmt.attr('UserDefinedValue') || cmt.text()
      const usageTypes = toTexts($el.find('UseType'))
      const territoryCode = toTexts($el.find('TerritoryCode'))
      const validityStartDate = $el.find('ValidityPeriod > StartDate').text()
      const validityEndDate = $el.find('ValidityPeriod > EndDate').text()

      // only consider Worldwide
      const isWorldwide = territoryCode.includes('Worldwide')
      if (!isWorldwide) {
        return
      }

      // check date range
      {
        const startDate = new Date(validityStartDate)
        const endDate = new Date(validityEndDate)
        const now = new Date()
        if (startDate && now < startDate) {
          return
        }
        if (endDate && now > endDate) {
          return
        }
      }

      // add deal
      function addDeal(deal: AudiusSupportedDeal) {
        releaseDeals[ref] ||= []
        releaseDeals[ref].push(deal)
      }

      const common: DealFields = {
        forStream:
          usageTypes.includes('OnDemandStream') ||
          usageTypes.includes('Stream'),
        forDownload: usageTypes.includes('PermanentDownload'),
        validityStartDate,
        validityEndDate,
      }

      if (commercialModelType == 'FreeOfChargeModel') {
        addDeal({
          ...common,
          audiusDealType: 'Free',
        })
      } else if (commercialModelType == 'PayAsYouGoModel') {
        const deal: DealPayGated = {
          ...common,
          audiusDealType: 'PayGated',
        }
        const priceUsd = parseFloat(
          $el.find('WholesalePricePerUnit[CurrencyCode="USD"]').text()
        )
        if (priceUsd) {
          deal.priceUsd = priceUsd
        }
        addDeal(deal)
      } else if (
        commercialModelType == 'FollowGated' ||
        commercialModelType == 'TipGated'
      ) {
        addDeal({
          ...common,
          audiusDealType: commercialModelType,
        })
      } else if (commercialModelType == 'NFTGated') {
        const chain = $el.find('Chain').text()
        const address = $el.find('Address').text()
        const name = $el.find('Name').text()
        const imageUrl = $el.find('ImageUrl').text()
        const externalLink = $el.find('ExternalLink').text()

        // eth specific
        const standard = $el.find('Standard').text()
        const slug = $el.find('Slug').text()

        switch (chain) {
          case 'eth':
            addDeal({
              ...common,
              audiusDealType: 'NFTGated',
              chain,
              address,
              name,
              imageUrl,
              externalLink,
              standard,
              slug,
            })
            break
          case 'sol':
            addDeal({
              ...common,
              audiusDealType: 'NFTGated',
              chain,
              address,
              name,
              imageUrl,
              externalLink,
            })
            break
        }
      }
    })
  })

  // after parsing deals... if there is only a forDownload deal and no forStream deal
  // mark the forDownload deal as forStream... which will make this a pay gated track.
  // This is to support the most common version of `PayAsYouGoModel` deal xml.
  for (const [_ref, dealList] of Object.entries(releaseDeals)) {
    const forStream = dealList.find((d) => d.forStream)
    const forDownload = dealList.find((d) => d.forDownload)
    if (!forStream && forDownload) {
      forDownload.forStream = true
    }
  }

  //
  // parse resources
  //

  const soundResources: Record<string, DDEXSoundRecording> = {}
  const imageResources: Record<string, DDEXResource> = {}
  const textResources: Record<string, DDEXResource> = {}

  $('ResourceList > SoundRecording').each((_, el) => {
    const $el = $(el)

    const [genre, subGenre] = parseGenres($el)

    const recording: DDEXSoundRecording = {
      ref: $el.find('ResourceReference').text(),
      isrc: $el.find('ISRC').text(),

      filePath: $el.find('FilePath:first').text(),
      fileName: $el.find('FileName:first').text(),
      title: $el.find('TitleText:first').text(),
      subTitle: $el.find('SubTitle:first').text(),
      artists: parseContributor('DisplayArtist', $el),
      contributors: parseContributor('ResourceContributor', $el),
      indirectContributors: parseContributor(
        'IndirectResourceContributor',
        $el
      ),
      labelName: $el.find('LabelName').text(),
      duration: parseDuration($el.find('Duration').text()),
      previewStartSeconds: parseInt(
        $el.find('PreviewDetails > StartPoint:first').text()
      ),
      genre: genre,
      subGenre: subGenre,
      releaseDate: $el
        .find('OriginalResourceReleaseDate, ResourceReleaseDate')
        .first()
        .text(),

      copyrightLine: cline($el),
      producerCopyrightLine: pline($el),
      parentalWarningType: toText($el.find('ParentalWarningType')),
    }

    const rightsController = $el.find('RightsController').first()
    if (rightsController.length) {
      recording.rightsController = {
        name: toText(rightsController.find('PartyName FullName')),
        roles: toTexts(rightsController.find('RightsControllerRole')),
        // rightShareUnknown: toText(rightsController.find('RightShareUnknown'))
      }
    }

    recording.audiusGenre = resolveAudiusGenre(
      recording.genre,
      recording.subGenre
    )

    soundResources[recording.ref] = recording
  })

  function ddexResourceReducer(acc: Record<string, DDEXResource>, el: any) {
    const [ref, filePath, fileName] = [
      'ResourceReference',
      'FilePath',
      'FileName',
    ].map((k) => $(el).find(k).text())
    acc[ref] = { ref, filePath, fileName }
    return acc
  }

  $('ResourceList > Image')
    .toArray()
    .reduce(ddexResourceReducer, imageResources)

  $('ResourceList > Text').toArray().reduce(ddexResourceReducer, textResources)

  //
  // parse releases
  //

  const work = $('Release')
    .toArray()
    .map(async (el) => {
      const $el = $(el)

      const ref = $el.find('ReleaseReference').text()
      const deals = releaseDeals[ref] || []
      const validityStartDate = deals.length
        ? deals[0].validityStartDate
        : undefined

      const releaseDate =
        validityStartDate ||
        $el.find('ReleaseDate').text() ||
        $el.find('GlobalOriginalReleaseDate').text() ||
        $el.find('OriginalReleaseDate').text()

      const [genre, subGenre] = parseGenres($el)

      const release: DDEXRelease = {
        ref,
        title: $el.find('ReferenceTitle TitleText').text(),
        subTitle: $el.find('ReferenceTitle SubTitle').text(),
        artists: parseContributor('DisplayArtist', $el),
        contributors: parseContributor('ResourceContributor', $el),
        indirectContributors: parseContributor(
          'IndirectResourceContributor',
          $el
        ),
        labelName: $el.find('LabelName').text(),
        genre,
        subGenre,
        releaseIds: parseReleaseIds($el),
        releaseDate,
        releaseType: $el.find('ReleaseType').text(),

        copyrightLine: cline($el),
        producerCopyrightLine: pline($el),
        parentalWarningType: toText($el.find('ParentalWarningType')),

        isMainRelease: $el.attr('IsMainRelease') == 'true',

        problems: [],
        soundRecordings: [],
        images: [],
        deals,
      }

      // resolve audius genre
      release.audiusGenre = resolveAudiusGenre(release.genre, release.subGenre)
      if (!release.audiusGenre) {
        release.problems.push(`NoGenre`)
      }

      // resolve audius user (that has authorized this source)
      const artistNames = release.artists.map((a) => a.name)
      const sourceConfig = sources.findByName(source)
      if (sourceConfig) {
        release.audiusUser = await userRepo.match(
          sourceConfig.ddexKey,
          artistNames
        )
      }

      // resolve resources
      $el
        .find('ReleaseResourceReferenceList > ReleaseResourceReference')
        .each((_, el) => {
          const ref = $(el).text()

          if (soundResources[ref]) {
            release.soundRecordings.push(soundResources[ref])
          } else if (imageResources[ref]) {
            release.images.push(imageResources[ref])
          } else if (textResources[ref]) {
            console.log('ignoring text ref', ref)
          } else {
            // don't actually block on MissingRef...
            // if it's an update, refs might not be included...
            // if it's a create, this will simply become a publisher error when it tries to resolve a file...
            //     release.problems.push(`MissingRef: ${ref}`)
            console.log(`MissingRef: ${ref}`)
          }
        })

      // deal or no deal?
      if (new Date(release.releaseDate) > new Date()) {
        release.problems.push('FutureRelease')
      } else if (!release.deals.length) {
        release.problems.push('NoDeal')
      }

      return release
    })

  const releases = await Promise.all(work)

  // resolve any missing images to main release if possible
  const mainRelease = releases.find((r) => r.isMainRelease)
  for (const release of releases) {
    if (!release.images.length) {
      if (mainRelease?.images.length) {
        release.images = mainRelease.images
      } else {
        release.problems.push('NoImage')
      }
    }
  }

  // surpress any track releases that are part of main release
  if (mainRelease && mainRelease.problems.length == 0) {
    const mainReleaseRefs = new Set(
      mainRelease.soundRecordings.map((s) => s.ref)
    )
    for (const release of releases) {
      if (release.isMainRelease) continue
      const isSubset = release.soundRecordings.every((s) =>
        mainReleaseRefs.has(s.ref)
      )
      if (isSubset) {
        release.problems.push('DuplicateRelease')
      }
    }
  }

  return releases
}

//
// parse purge
//

function parsePurgeXml($: cheerio.CheerioAPI): DDEXPurgeRelease {
  // todo: is it possible multiple releases purged in one message?
  const releaseIds = parseReleaseIds($('PurgedRelease').first())
  return { releaseIds }
}

//
// helpers
//

function toText($el: CH) {
  return $el.first().text().trim()
}

export function parseReleaseIds($el: CH): DDEXReleaseIds {
  return omitEmpty({
    party_id: toText($el.find('ReleaseId > PartyId')),
    catalog_number: toText($el.find('ReleaseId > CatalogNumber')),
    icpn: toText($el.find('ReleaseId > ICPN')),
    grid: toText($el.find('ReleaseId > GRid')),
    isan: toText($el.find('ReleaseId > ISAN')),
    isbn: toText($el.find('ReleaseId > ISBN')),
    ismn: toText($el.find('ReleaseId > ISMN')),
    isrc: toText($el.find('ReleaseId > ISRC')),
    issn: toText($el.find('ReleaseId > ISSN')),
    istc: toText($el.find('ReleaseId > ISTC')),
    iswc: toText($el.find('ReleaseId > ISWC')),
    mwli: toText($el.find('ReleaseId > MWLI')),
    sici: toText($el.find('ReleaseId > SICI')),
    proprietary_id: toText($el.find('ReleaseId > ProprietaryId')),
  })
}

const genreMapping: Record<string, Genre> = {
  Dance: Genre.ELECTRONIC,
  'Indie Rock': Genre.ALTERNATIVE,
  Inspirational: Genre.AMBIENT,
}

function resolveAudiusGenre(
  genre: string,
  subgenre: string
): Genre | undefined {
  if (!genre && !subgenre) {
    return
  }

  // first try subgenre, then genre
  for (let searchTerm of [subgenre, genre]) {
    searchTerm = lowerAscii(searchTerm)
    for (const v of Object.values(Genre)) {
      if (lowerAscii(v) == searchTerm) {
        return v
      }
    }
  }

  // hard code some genre matching??
  if (genreMapping[genre]) {
    return genreMapping[genre]
  }

  // maybe try some edit distance magic?
  // for now just log
  console.warn(`failed to resolve genre: subgenre=${subgenre} genre=${genre}`)
}

export function parseDuration(dur: string) {
  const m = dur.match(/PT(\d+H)?(\d+M)?(\d+S)?/)
  if (!m) return
  const hours = parseInt(m[1]) || 0
  const minutes = parseInt(m[2]) || 0
  const seconds = parseInt(m[3]) || 0
  const totalSeconds = hours * 3600 + minutes * 60 + seconds
  return totalSeconds
}
