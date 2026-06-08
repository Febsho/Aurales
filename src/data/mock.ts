import type { MovieDetails, ShowDetails, SearchResult, SeasonDetails, Video } from '../types'

export const MOCK_HERO_MOVIE: MovieDetails = {
  id: 'mock-1',
  title: 'Interstellar',
  originalTitle: 'Interstellar',
  year: 2014,
  releaseDate: '2014-11-07',
  overview: "A team of explorers travel through a wormhole in space in an attempt to ensure humanity's survival. When Earth becomes uninhabitable, a group of astronauts must venture beyond our solar system to find a new home for mankind.",
  tagline: 'Mankind was born on Earth. It was never meant to die here.',
  runtime: 169,
  rating: 8.6,
  voteCount: 34521,
  genres: ['Adventure', 'Drama', 'Science Fiction'],
  poster: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
  backdrop: 'https://image.tmdb.org/t/p/original/xJHokMbljvjADYdit5fK1DVfjko.jpg',
  logo: undefined,
  certification: 'PG-13',
  cast: [
    { id: '1', name: 'Matthew McConaughey', character: 'Joseph Cooper', profilePath: 'https://image.tmdb.org/t/p/w185/wJiGedOCZhwMx9DezY8uwbNxmAY.jpg' },
    { id: '2', name: 'Anne Hathaway', character: 'Dr. Amelia Brand', profilePath: 'https://image.tmdb.org/t/p/w185/tLelKoPNiyJCSEtQTz1FGv4TLGc.jpg' },
    { id: '3', name: 'Jessica Chastain', character: 'Murphy Cooper', profilePath: 'https://image.tmdb.org/t/p/w185/lodMzLKSdrPcBry2sALCdPGxzjh.jpg' },
    { id: '4', name: 'Michael Caine', character: 'Professor Brand', profilePath: 'https://image.tmdb.org/t/p/w185/bGZn5RBzLBAGoLdCEXLGBFjQOIm.jpg' },
    { id: '5', name: 'Matt Damon', character: 'Dr. Mann', profilePath: 'https://image.tmdb.org/t/p/w185/ehBRl2M2Ys1FUTRTuvRLijcBDHE.jpg' },
  ],
  crew: [
    { id: '10', name: 'Christopher Nolan', job: 'Director', department: 'Directing', profilePath: undefined },
    { id: '11', name: 'Hans Zimmer', job: 'Original Music Composer', department: 'Sound', profilePath: undefined },
  ],
  recommendations: [],
  trailers: [
    { id: 'v1', name: 'Official Trailer', key: 'zSWdZVtXT7E', site: 'YouTube', type: 'Trailer', thumbnail: 'https://img.youtube.com/vi/zSWdZVtXT7E/hqdefault.jpg' },
    { id: 'v2', name: 'Teaser Trailer', key: '0vxOhd4qlnA', site: 'YouTube', type: 'Teaser', thumbnail: 'https://img.youtube.com/vi/0vxOhd4qlnA/hqdefault.jpg' },
  ],
  imdbId: 'tt0816692',
}

export const MOCK_SHOW: ShowDetails = {
  id: 'mock-show-1',
  title: 'Breaking Bad',
  originalTitle: 'Breaking Bad',
  year: 2008,
  firstAirDate: '2008-01-20',
  overview: 'Walter White, a New Mexico chemistry teacher, is diagnosed with Stage III cancer and given a prognosis of two years left to live. He becomes filled with a sense of fearlessness and an unrelenting desire to secure his family\'s financial future at any cost as he enters the dangerous world of drugs and crime.',
  tagline: 'Change the equation.',
  rating: 8.9,
  voteCount: 13456,
  genres: ['Drama', 'Crime', 'Thriller'],
  poster: 'https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
  backdrop: 'https://image.tmdb.org/t/p/original/gc8PfyTqzqltKMCr3srFGYKR9eE.jpg',
  logo: undefined,
  certification: 'TV-MA',
  status: 'Ended',
  numberOfSeasons: 5,
  numberOfEpisodes: 62,
  seasons: [
    { seasonNumber: 1, name: 'Season 1', episodeCount: 7, poster: undefined, airDate: '2008-01-20' },
    { seasonNumber: 2, name: 'Season 2', episodeCount: 13, poster: undefined, airDate: '2009-03-08' },
    { seasonNumber: 3, name: 'Season 3', episodeCount: 13, poster: undefined, airDate: '2010-03-21' },
    { seasonNumber: 4, name: 'Season 4', episodeCount: 13, poster: undefined, airDate: '2011-07-17' },
    { seasonNumber: 5, name: 'Season 5', episodeCount: 16, poster: undefined, airDate: '2012-07-15' },
  ],
  cast: [
    { id: '20', name: 'Bryan Cranston', character: 'Walter White', profilePath: 'https://image.tmdb.org/t/p/w185/7Jahy5LZX2Fo8fGJltMreAI49hC.jpg' },
    { id: '21', name: 'Aaron Paul', character: 'Jesse Pinkman', profilePath: 'https://image.tmdb.org/t/p/w185/8Ac9uuoYwZoYVAIJpZal7v0v1bN.jpg' },
    { id: '22', name: 'Anna Gunn', character: 'Skyler White', profilePath: 'https://image.tmdb.org/t/p/w185/adppyeu1a4REN3khtgmXeLRepx.jpg' },
  ],
  crew: [
    { id: '30', name: 'Vince Gilligan', job: 'Creator', department: 'Writing', profilePath: undefined },
  ],
  recommendations: [],
  trailers: [
    { id: 'sv1', name: 'Official Trailer', key: 'HhesaQXLuRY', site: 'YouTube', type: 'Trailer', thumbnail: 'https://img.youtube.com/vi/HhesaQXLuRY/hqdefault.jpg' },
  ],
  imdbId: 'tt0903747',
}

export const MOCK_SEASON: SeasonDetails = {
  seasonNumber: 1,
  name: 'Season 1',
  overview: 'High school chemistry teacher Walter White\'s life is suddenly transformed by a dire medical diagnosis.',
  poster: undefined,
  episodes: [
    { id: 'ep1', episodeNumber: 1, seasonNumber: 1, name: 'Pilot', overview: 'Walter White, a struggling high school chemistry teacher, is diagnosed with advanced lung cancer.', airDate: '2008-01-20', runtime: 58, still: undefined, rating: 8.0, voteCount: 5432 },
    { id: 'ep2', episodeNumber: 2, seasonNumber: 1, name: "Cat's in the Bag...", overview: 'Walt and Jesse attempt to tie up loose ends.', airDate: '2008-01-27', runtime: 48, still: undefined, rating: 7.8, voteCount: 4321 },
    { id: 'ep3', episodeNumber: 3, seasonNumber: 1, name: '...And the Bag\'s in the River', overview: 'Walt deals with the chain of events set off by their decaying prisoner.', airDate: '2008-02-10', runtime: 48, still: undefined, rating: 8.1, voteCount: 4567 },
    { id: 'ep4', episodeNumber: 4, seasonNumber: 1, name: 'Cancer Man', overview: 'Walt tells the family about his condition.', airDate: '2008-02-17', runtime: 48, still: undefined, rating: 7.7, voteCount: 3890 },
    { id: 'ep5', episodeNumber: 5, seasonNumber: 1, name: 'Gray Matter', overview: 'Walt accepts an offer from an old friend.', airDate: '2008-02-24', runtime: 48, still: undefined, rating: 7.9, voteCount: 3765 },
    { id: 'ep6', episodeNumber: 6, seasonNumber: 1, name: 'Crazy Handful of Nothin\'', overview: 'Walt ventures further into the drug world.', airDate: '2008-03-02', runtime: 48, still: undefined, rating: 8.7, voteCount: 5678 },
    { id: 'ep7', episodeNumber: 7, seasonNumber: 1, name: 'A No-Rough-Stuff-Type Deal', overview: 'The DEA is tightening the net, unaware the prey is close to home.', airDate: '2008-03-09', runtime: 48, still: undefined, rating: 8.5, voteCount: 4890 },
  ],
}

export const MOCK_TRENDING: SearchResult[] = [
  { id: 'mock-1', title: 'Interstellar', type: 'movie', year: 2014, poster: 'https://image.tmdb.org/t/p/w342/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/xJHokMbljvjADYdit5fK1DVfjko.jpg', rating: 8.6, provider: 'mock' },
  { id: 'mock-2', title: 'The Dark Knight', type: 'movie', year: 2008, poster: 'https://image.tmdb.org/t/p/w342/qJ2tW6WMUDux911BTUgMe1F608y.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/hkBaDkMWbLaf8B1lsWsKX7Ew3Xq.jpg', rating: 9.0, provider: 'mock' },
  { id: 'mock-3', title: 'Inception', type: 'movie', year: 2010, poster: 'https://image.tmdb.org/t/p/w342/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', rating: 8.4, provider: 'mock' },
  { id: 'mock-4', title: 'Fight Club', type: 'movie', year: 1999, poster: 'https://image.tmdb.org/t/p/w342/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/hZkgoQYus5dXo3H8T7Uef6DNknx.jpg', rating: 8.4, provider: 'mock' },
  { id: 'mock-5', title: 'The Matrix', type: 'movie', year: 1999, poster: 'https://image.tmdb.org/t/p/w342/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/fNG7i7RqMErkcqhohV2a6cV1Ehy.jpg', rating: 8.2, provider: 'mock' },
  { id: 'mock-6', title: 'Pulp Fiction', type: 'movie', year: 1994, poster: 'https://image.tmdb.org/t/p/w342/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/suaEOtk1N1sgg2MTM7oZd2cfVp3.jpg', rating: 8.5, provider: 'mock' },
  { id: 'mock-7', title: 'Dune: Part Two', type: 'movie', year: 2024, poster: 'https://image.tmdb.org/t/p/w342/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg', rating: 8.3, provider: 'mock' },
  { id: 'mock-8', title: 'Oppenheimer', type: 'movie', year: 2023, poster: 'https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/nb3xI8XI3w4pMVZ38VijbsyBqP4.jpg', rating: 8.1, provider: 'mock' },
]

export const MOCK_POPULAR_SHOWS: SearchResult[] = [
  { id: 'mock-show-1', title: 'Breaking Bad', type: 'series', year: 2008, poster: 'https://image.tmdb.org/t/p/w342/ggFHVNu6YYI5L9pCfOacjizRGt.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/gc8PfyTqzqltKMCr3srFGYKR9eE.jpg', rating: 8.9, provider: 'mock' },
  { id: 'mock-show-2', title: 'Game of Thrones', type: 'series', year: 2011, poster: 'https://image.tmdb.org/t/p/w342/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg', rating: 8.5, provider: 'mock' },
  { id: 'mock-show-3', title: 'Stranger Things', type: 'series', year: 2016, poster: 'https://image.tmdb.org/t/p/w342/49WJfeN0moxb9IPfGn8AIqMGskD.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/56v2KjBlYj3Hy0bHkdKI8FWL4fZ.jpg', rating: 8.6, provider: 'mock' },
  { id: 'mock-show-4', title: 'The Mandalorian', type: 'series', year: 2019, poster: 'https://image.tmdb.org/t/p/w342/eU1i6eHXlzMOlEq0ku1Bdo2Ynpr.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/9ijMGlJKqcslswWUzTEwScm82Gs.jpg', rating: 8.5, provider: 'mock' },
  { id: 'mock-show-5', title: 'The Last of Us', type: 'series', year: 2023, poster: 'https://image.tmdb.org/t/p/w342/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg', rating: 8.8, provider: 'mock' },
  { id: 'mock-show-6', title: 'Severance', type: 'series', year: 2022, poster: 'https://image.tmdb.org/t/p/w342/lFf6DEhcEMErTEEjM0V3AoUQOBk.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/sNaVyLz0z6Z5bsK4bKe4cUkqe0C.jpg', rating: 8.7, provider: 'mock' },
]

export const MOCK_TRAILERS: Video[] = MOCK_HERO_MOVIE.trailers

export const MOCK_ADDON_MANIFEST = {
  id: 'com.example.mockaddon',
  name: 'Mock Addon',
  version: '1.0.0',
  description: 'A sample addon with mock data for development',
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie' as const, id: 'mock-movies', name: 'Mock Movies' },
    { type: 'series' as const, id: 'mock-series', name: 'Mock Series' },
  ],
}
