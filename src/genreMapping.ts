import { Genre } from '@audius/sdk'

// Maps DDEX/distributor genre strings to Audius genres.
// resolveAudiusGenre() first tries a case-insensitive exact match against
// the Genre enum values, so only non-obvious mappings need to be listed here.
export const genreMapping: Record<string, Genre> = {
  // Hip-Hop variants
  'Hip Hop': Genre.HIP_HOP_RAP,
  'Hip Hop, A capella': Genre.HIP_HOP_RAP,
  'Hip-Hop': Genre.HIP_HOP_RAP,
  'Hip-hop/Rap': Genre.HIP_HOP_RAP,
  'Hip Hop/Rap': Genre.HIP_HOP_RAP,
  'Alternative Rap': Genre.HIP_HOP_RAP,
  'Gangsta Rap': Genre.HIP_HOP_RAP,
  'Hardcore Rap': Genre.HIP_HOP_RAP,
  'Latin Rap': Genre.HIP_HOP_RAP,
  'Old School Rap': Genre.HIP_HOP_RAP,
  Rap: Genre.HIP_HOP_RAP,
  'UK Hip Hop': Genre.HIP_HOP_RAP,
  'Underground Rap': Genre.HIP_HOP_RAP,
  'West Coast Rap': Genre.HIP_HOP_RAP,

  // Electronic / Dance variants
  Dance: Genre.ELECTRONIC,
  'Dance/House/Techno': Genre.ELECTRONIC,
  Electronic: Genre.ELECTRONIC,
  Electronica: Genre.ELECTRONIC,
  'Electronic, Pop': Genre.ELECTRONIC,
  'IDM/Experimental': Genre.ELECTRONIC,
  Breakbeat: Genre.ELECTRONIC,
  Bassline: Genre.ELECTRONIC,
  Garage: Genre.ELECTRONIC,
  Grime: Genre.ELECTRONIC,
  Hardcore: Genre.ELECTRONIC,
  'Psy-Trance ': Genre.TRANCE,
  'Baile Funk': Genre.ELECTRONIC,
  Phonk: Genre.ELECTRONIC,
  'Electro House': Genre.HOUSE,
  'Afro House': Genre.HOUSE,
  'Dub Step': Genre.DUBSTEP,
  "Jungle/Drum'n'bass": Genre.DRUM_AND_BASS,
  'Melodic Techno': Genre.TECHNO,

  // Rock variants
  Rock: Genre.ROCK,
  'Indie Rock': Genre.ALTERNATIVE,
  'Blues-Rock': Genre.ROCK,
  'Blues Rock': Genre.ROCK,
  'College Rock': Genre.ROCK,
  'Folk-Rock': Genre.FOLK,
  'Goth Rock': Genre.ROCK,
  'Pop/Rock': Genre.ROCK,
  'Prog-Rock/Art Rock': Genre.ROCK,
  'Rock & Roll': Genre.ROCK,
  'Southern Rock': Genre.ROCK,
  'Soft Rock': Genre.POP,
  'Deutschrock/-pop': Genre.ROCK,
  'Christian Rock': Genre.ROCK,

  // Metal variants
  Metal: Genre.METAL,
  'Heavy Metal': Genre.METAL,
  'Death Metal/Black Metal': Genre.METAL,
  'Metal/Hard Rock': Genre.METAL,

  // Pop variants
  Pop: Genre.POP,
  'Indie Pop': Genre.POP,
  'Vocal Pop': Genre.POP,
  'Traditional Pop': Genre.POP,
  'Pop Punk': Genre.PUNK,
  'Adult Contemporary': Genre.POP,
  'French Pop': Genre.POP,
  'German Pop': Genre.POP,
  'Pop in Spanish': Genre.POP,
  'Christian Pop': Genre.POP,
  'Chinese Pop/Rock': Genre.POP,

  // R&B / Soul variants
  'R&B': Genre.R_AND_B_SOUL,
  'R&B/Soul': Genre.R_AND_B_SOUL,
  'Contemporary R&B': Genre.R_AND_B_SOUL,
  'Neo-Soul': Genre.R_AND_B_SOUL,
  Soul: Genre.R_AND_B_SOUL,
  'Afro Soul': Genre.R_AND_B_SOUL,

  // Jazz variants
  Jazz: Genre.JAZZ,
  'Smooth Jazz': Genre.JAZZ,

  // Blues variants
  Blues: Genre.BLUES,
  'Country Blues': Genre.BLUES,

  // Classical variants
  Classical: Genre.CLASSICAL,
  'Classical Crossover': Genre.CLASSICAL,
  Choral: Genre.CLASSICAL,
  Opera: Genre.CLASSICAL,
  Orchestral: Genre.CLASSICAL,
  'Carnatic Classical': Genre.CLASSICAL,
  'Hindustani Classical': Genre.CLASSICAL,
  'Indian Classical': Genre.CLASSICAL,

  // Country
  Country: Genre.COUNTRY,
  'Country-Rock': Genre.COUNTRY,

  // Folk
  Folk: Genre.FOLK,
  'Traditional Folk': Genre.FOLK,

  // Reggae / Dancehall variants
  Reggae: Genre.REGGAE,
  'African Reggae': Genre.REGGAE,
  'African Dancehall': Genre.DANCEHALL,

  // Latin variants
  Latin: Genre.LATIN,
  'Latin Music': Genre.LATIN,
  Bachata: Genre.LATIN,
  Cumbia: Genre.LATIN,
  'Reggaeton / Latin Urban': Genre.LATIN,
  'Salsa y Tropical': Genre.LATIN,
  Sertanejo: Genre.LATIN,
  Forró: Genre.LATIN,
  Pagode: Genre.LATIN,
  MPB: Genre.LATIN,
  Axé: Genre.LATIN,

  // World / Regional
  World: Genre.WORLD,
  'World Music': Genre.WORLD,
  African: Genre.WORLD,
  'Afro-Beat': Genre.WORLD,
  Afrobeats: Genre.WORLD,
  'Afro-fusion': Genre.WORLD,
  'Afro-Pop': Genre.WORLD,
  Amapiano: Genre.WORLD,
  Kwaito: Genre.WORLD,
  Kizomba: Genre.WORLD,
  Arabic: Genre.WORLD,
  'Arabic Pop': Genre.WORLD,
  Brazilian: Genre.WORLD,
  Flamenco: Genre.WORLD,
  Indian: Genre.WORLD,
  'Indian Folk': Genre.WORLD,
  'Indian Pop': Genre.WORLD,
  'Regional Indian': Genre.WORLD,
  Assamese: Genre.WORLD,
  Malayalam: Genre.WORLD,
  Tamil: Genre.WORLD,
  'Soundtrack (Tamil)': Genre.SOUNDTRACK,
  Bollywood: Genre.WORLD,
  Japan: Genre.WORLD,
  'J-Pop': Genre.POP,
  'K-Pop': Genre.POP,
  Swing: Genre.JAZZ,

  // Ambient / Chill
  Ambient: Genre.AMBIENT,
  'Ambient / Chillout': Genre.AMBIENT,
  Inspirational: Genre.AMBIENT,
  'New Age': Genre.AMBIENT,
  Meditation: Genre.AMBIENT,
  Lounge: Genre.AMBIENT,

  // Soundtrack
  Soundtrack: Genre.SOUNDTRACK,
  Soundtracks: Genre.SOUNDTRACK,
  'Original Score': Genre.SOUNDTRACK,
  'Foreign Cinema': Genre.SOUNDTRACK,
  Anime: Genre.SOUNDTRACK,

  // Spoken Word / Vocal
  'Spoken Word': Genre.SPOKEN_WORK,
  Vocal: Genre.SPOKEN_WORK,

  // Comedy
  Comedy: Genre.COMEDY,

  // Kids
  Kids: Genre.KIDS,
  "Children's": Genre.KIDS,
  "Children's Music": Genre.KIDS,
  Lullabies: Genre.KIDS,

  // Audiobooks
  Audiobooks: Genre.AUDIOBOOKS,
  Audiobook: Genre.AUDIOBOOKS,
  'Audio Play': Genre.AUDIOBOOKS,

  // Gospel / Devotional
  'Devotional & Spiritual': Genre.DEVOTIONAL,
  Christian: Genre.DEVOTIONAL,
  'Christian & Gospel': Genre.DEVOTIONAL,
  Gospel: Genre.DEVOTIONAL,

  // Other
  'Singer/Songwriter': Genre.ACOUSTIC,
  'New Acoustic': Genre.ACOUSTIC,
  Guitar: Genre.ACOUSTIC,
  Piano: Genre.CLASSICAL,
  'Solo Instrumental': Genre.CLASSICAL,
  Instrumental: Genre.ACOUSTIC,
  'Easy Listening': Genre.POP,
  'New Wave': Genre.ALTERNATIVE,
  EMO: Genre.ALTERNATIVE,
  'Marching Bands': Genre.CLASSICAL,
  Holiday: Genre.POP,
  Christmas: Genre.POP,
  'Christmas: Children\'s': Genre.KIDS,
  'Christmas: Classic': Genre.POP,
  'Christmas: Jazz': Genre.JAZZ,
  'Christmas: Modern': Genre.POP,

  // Direct Audius genre matches (kept for explicitness)
  Experimental: Genre.EXPERIMENTAL,
  Punk: Genre.PUNK,
  Acoustic: Genre.ACOUSTIC,
  Funk: Genre.FUNK,
  Devotional: Genre.DEVOTIONAL,
  Podcasts: Genre.PODCASTS,
  'Lo-Fi': Genre.LOFI,
  Hyperpop: Genre.HYPERPOP,
  Techno: Genre.TECHNO,
  Trap: Genre.TRAP,
  House: Genre.HOUSE,
  'Tech House': Genre.TECH_HOUSE,
  'Deep House': Genre.DEEP_HOUSE,
  Disco: Genre.DISCO,
  Electro: Genre.ELECTRO,
  Jungle: Genre.JUNGLE,
  'Progressive House': Genre.PROGRESSIVE_HOUSE,
  Hardstyle: Genre.HARDSTYLE,
  'Glitch Hop': Genre.GLITCH_HOP,
  Trance: Genre.TRANCE,
  'Future Bass': Genre.FUTURE_BASS,
  'Future House': Genre.FUTURE_HOUSE,
  'Tropical House': Genre.TROPICAL_HOUSE,
  Downtempo: Genre.DOWNTEMPO,
  'Drum & Bass': Genre.DRUM_AND_BASS,
  Dubstep: Genre.DUBSTEP,
  Alternative: Genre.ALTERNATIVE,
  'Hip-Hop/Rap': Genre.HIP_HOP_RAP,
  Dancehall: Genre.DANCEHALL,
}
