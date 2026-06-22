import { Genre } from '@audius/sdk'

// Maps DDEX/distributor genre strings to Audius genres.
// resolveAudiusGenre() first tries a case-insensitive exact match against
// the Genre enum values, so only non-obvious mappings need to be listed here.
export const genreMapping: Record<string, Genre> = {
  // Hip-Hop variants
  'Hip Hop': Genre.HipHopRap,
  'Hip Hop, A capella': Genre.HipHopRap,
  'Hip-Hop': Genre.HipHopRap,
  'Hip-hop/Rap': Genre.HipHopRap,
  'Hip Hop/Rap': Genre.HipHopRap,
  'Hip-Hop, Rap': Genre.HipHopRap,
  'Hio hop': Genre.HipHopRap,
  'Baltimore Club HIPHOP': Genre.HipHopRap,
  'Pop, Dance, Hip Hop': Genre.HipHopRap,
  'Alternative Rap': Genre.HipHopRap,
  'Gangsta Rap': Genre.HipHopRap,
  'Hardcore Rap': Genre.HipHopRap,
  'Latin Rap': Genre.HipHopRap,
  'Old School Rap': Genre.HipHopRap,
  Rap: Genre.HipHopRap,
  'UK Hip Hop': Genre.HipHopRap,
  'Underground Rap': Genre.HipHopRap,
  'West Coast Rap': Genre.HipHopRap,

  // Electronic / Dance variants
  Dance: Genre.Electronic,
  'Dance/House/Techno': Genre.Electronic,
  Electronic: Genre.Electronic,
  Electronica: Genre.Electronic,
  'Electronic, Pop': Genre.Electronic,
  'EDM, HIP HOP': Genre.Electronic,
  'IDM/Experimental': Genre.Electronic,
  Breakbeat: Genre.Electronic,
  Bassline: Genre.Electronic,
  Garage: Genre.Electronic,
  Grime: Genre.Electronic,
  Hardcore: Genre.Electronic,
  'Psy-Trance ': Genre.Trance,
  'Baile Funk': Genre.Electronic,
  Phonk: Genre.Electronic,
  'Electro House': Genre.House,
  'Afro House': Genre.House,
  'Dub Step': Genre.Dubstep,
  "Jungle/Drum'n'bass": Genre.DrumBass,
  'Melodic Techno': Genre.Techno,

  // Rock variants
  Rock: Genre.Rock,
  'Indie Rock': Genre.Alternative,
  'Blues-Rock': Genre.Rock,
  'Blues Rock': Genre.Rock,
  'College Rock': Genre.Rock,
  'Folk-Rock': Genre.Folk,
  'Goth Rock': Genre.Rock,
  'Pop/Rock': Genre.Rock,
  'Prog-Rock/Art Rock': Genre.Rock,
  'Rock & Roll': Genre.Rock,
  'Southern Rock': Genre.Rock,
  'Soft Rock': Genre.Pop,
  'Deutschrock/-pop': Genre.Rock,
  'Christian Rock': Genre.Rock,

  // Metal variants
  Metal: Genre.Metal,
  'Heavy Metal': Genre.Metal,
  'Death Metal/Black Metal': Genre.Metal,
  'Metal/Hard Rock': Genre.Metal,

  // Pop variants
  Pop: Genre.Pop,
  'Indie Pop': Genre.Pop,
  'Vocal Pop': Genre.Pop,
  'Traditional Pop': Genre.Pop,
  'Pop Punk': Genre.Punk,
  'Adult Contemporary': Genre.Pop,
  'French Pop': Genre.Pop,
  'German Pop': Genre.Pop,
  'Pop in Spanish': Genre.Pop,
  'Christian Pop': Genre.Pop,
  'Chinese Pop/Rock': Genre.Pop,

  // R&B / Soul variants
  'R&B': Genre.RbSoul,
  'R&B/Soul': Genre.RbSoul,
  'Contemporary R&B': Genre.RbSoul,
  'Neo-Soul': Genre.RbSoul,
  Soul: Genre.RbSoul,
  'Afro Soul': Genre.RbSoul,

  // Funk variants
  'Funk, R,% B, Soul,': Genre.Funk,

  // Jazz variants
  Jazz: Genre.Jazz,
  'Smooth Jazz': Genre.Jazz,
  'Jazz Funk': Genre.Funk,

  // Blues variants
  Blues: Genre.Blues,
  'Country Blues': Genre.Blues,

  // Classical variants
  Classical: Genre.Classical,
  'Classical Crossover': Genre.Classical,
  Choral: Genre.Classical,
  Opera: Genre.Classical,
  Orchestral: Genre.Classical,
  'Carnatic Classical': Genre.Classical,
  'Hindustani Classical': Genre.Classical,
  'Indian Classical': Genre.Classical,

  // Country
  Country: Genre.Country,
  'Country-Rock': Genre.Country,

  // Folk
  Folk: Genre.Folk,
  'Traditional Folk': Genre.Folk,

  // Reggae / Dancehall variants
  Reggae: Genre.Reggae,
  'African Reggae': Genre.Reggae,
  'African Dancehall': Genre.Dancehall,

  // Latin variants
  Latin: Genre.Latin,
  'Latin Music': Genre.Latin,
  Bachata: Genre.Latin,
  Cumbia: Genre.Latin,
  'Reggaeton / Latin Urban': Genre.Latin,
  'Salsa y Tropical': Genre.Latin,
  Sertanejo: Genre.Latin,
  Forró: Genre.Latin,
  Pagode: Genre.Latin,
  MPB: Genre.Latin,
  Axé: Genre.Latin,

  // World / Regional
  World: Genre.World,
  'World Music': Genre.World,
  African: Genre.World,
  'Afro-Beat': Genre.World,
  Afrobeats: Genre.World,
  'Afro-fusion': Genre.World,
  'Afro-Pop': Genre.World,
  Amapiano: Genre.World,
  Kwaito: Genre.World,
  Kizomba: Genre.World,
  Arabic: Genre.World,
  'Arabic Pop': Genre.World,
  Brazilian: Genre.World,
  Flamenco: Genre.World,
  Indian: Genre.World,
  'Indian Folk': Genre.World,
  'Indian Pop': Genre.World,
  'Regional Indian': Genre.World,
  Assamese: Genre.World,
  Malayalam: Genre.World,
  Tamil: Genre.World,
  'Soundtrack (Tamil)': Genre.Soundtrack,
  Bollywood: Genre.World,
  Japan: Genre.World,
  'J-Pop': Genre.Pop,
  'K-Pop': Genre.Pop,
  Swing: Genre.Jazz,

  // Ambient / Chill
  Ambient: Genre.Ambient,
  'Ambient / Chillout': Genre.Ambient,
  Inspirational: Genre.Ambient,
  'New Age': Genre.Ambient,
  Meditation: Genre.Ambient,
  Lounge: Genre.Ambient,

  // Soundtrack
  Soundtrack: Genre.Soundtrack,
  Soundtracks: Genre.Soundtrack,
  'Original Score': Genre.Soundtrack,
  'Foreign Cinema': Genre.Soundtrack,
  Anime: Genre.Soundtrack,

  // Spoken Word / Vocal
  'Spoken Word': Genre.SpokenWord,
  Vocal: Genre.SpokenWord,

  // Comedy
  Comedy: Genre.Comedy,

  // Kids
  Kids: Genre.Kids,
  "Children's": Genre.Kids,
  "Children's Music": Genre.Kids,
  Lullabies: Genre.Kids,

  // Audiobooks
  Audiobooks: Genre.Audiobooks,
  Audiobook: Genre.Audiobooks,
  'Audio Play': Genre.Audiobooks,

  // Gospel / Devotional
  'Devotional & Spiritual': Genre.Devotional,
  'Devotional/Spiritual': Genre.Devotional,
  Christian: Genre.Devotional,
  'Christian & Gospel': Genre.Devotional,
  Gospel: Genre.Devotional,

  // Other
  'Singer/Songwriter': Genre.Acoustic,
  'New Acoustic': Genre.Acoustic,
  Guitar: Genre.Acoustic,
  Piano: Genre.Classical,
  'Solo Instrumental': Genre.Classical,
  Instrumental: Genre.Acoustic,
  'Easy Listening': Genre.Pop,
  'New Wave': Genre.Alternative,
  EMO: Genre.Alternative,
  'Marching Bands': Genre.Classical,
  Holiday: Genre.Pop,
  Christmas: Genre.Pop,
  'Christmas: Children\'s': Genre.Kids,
  'Christmas: Classic': Genre.Pop,
  'Christmas: Jazz': Genre.Jazz,
  'Christmas: Modern': Genre.Pop,

  // Direct Audius genre matches (kept for explicitness)
  Experimental: Genre.Experimental,
  Punk: Genre.Punk,
  Acoustic: Genre.Acoustic,
  Funk: Genre.Funk,
  Devotional: Genre.Devotional,
  Podcasts: Genre.Podcasts,
  'Lo-Fi': Genre.LoFi,
  Hyperpop: Genre.Hyperpop,
  Techno: Genre.Techno,
  Trap: Genre.Trap,
  House: Genre.House,
  'Tech House': Genre.TechHouse,
  'Deep House': Genre.DeepHouse,
  Disco: Genre.Disco,
  Electro: Genre.Electro,
  Jungle: Genre.Jungle,
  'Progressive House': Genre.ProgressiveHouse,
  Hardstyle: Genre.Hardstyle,
  'Glitch Hop': Genre.GlitchHop,
  Trance: Genre.Trance,
  'Future Bass': Genre.FutureBass,
  'Future House': Genre.FutureHouse,
  'Tropical House': Genre.TropicalHouse,
  Downtempo: Genre.Downtempo,
  'Drum & Bass': Genre.DrumBass,
  Dubstep: Genre.Dubstep,
  Alternative: Genre.Alternative,
  'Hip-Hop/Rap': Genre.HipHopRap,
  Dancehall: Genre.Dancehall,
}
