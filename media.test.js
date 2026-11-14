// node media.test.js — checks the song filter and the artist/song guesses
const assert = require('assert');
const { looksLikeSong, trackCandidates } = require('./media');

// songs
assert(looksLikeSong({ app: 'com.spotify.client', title: 'BbY WOW', artist: 'KAROL G', duration: 225 }));
assert(looksLikeSong({ app: 'Chrome', title: 'Arijit Singh - Kesariya (Official Video)', artist: 'Sony Music India', duration: 270 }));
assert(looksLikeSong({ app: 'com.google.Chrome', title: 'Good News', artist: 'Mac Miller', duration: 342 }));
// not songs
assert(!looksLikeSong(null));
assert(!looksLikeSong({ app: 'Chrome', title: 'Inception', artist: '', duration: 8880 }), 'film');
assert(!looksLikeSong({ app: 'MSEdge', title: 'Stranger Things', artist: 'Netflix', duration: 3100 }), 'episode length');
assert(!looksLikeSong({ app: 'Chrome', title: 'Dune: Part Two | Official Trailer', artist: 'Warner Bros.', duration: 180 }), 'trailer');
assert(!looksLikeSong({ app: 'Chrome', title: 'The Office S03E04 clip', artist: 'NBC', duration: 200 }), 'show clip');
assert(!looksLikeSong({ app: 'Chrome', title: 'Some show', artist: '', duration: 0 }), 'no artist');
assert(!looksLikeSong({ app: 'Spotify.exe', title: 'Advertisement', artist: 'Spotify', duration: 15 }), 'ad');

// guesses
assert.deepStrictEqual(trackCandidates({ app: 'com.spotify.client', title: 'Song - Remastered 2011', artist: 'Band' }),
  [{ name: 'Song - Remastered 2011', artist: 'Band' }]);
assert.deepStrictEqual(trackCandidates({ app: 'Chrome', title: '(2) Arijit Singh - Kesariya | Brahmastra', artist: 'Sony Music India' }),
  [{ artist: 'Arijit Singh', name: 'Kesariya' }, { artist: 'Sony Music India', name: 'Arijit Singh - Kesariya' }]);
assert.deepStrictEqual(trackCandidates({ app: 'Chrome', title: 'Blinding Lights', artist: 'The Weeknd - Topic' }),
  [{ artist: 'The Weeknd', name: 'Blinding Lights' }]);
assert.deepStrictEqual(trackCandidates({ app: 'Chrome', title: 'Hello', artist: 'AdeleVEVO' }),
  [{ artist: 'Adele', name: 'Hello' }]);
console.log('media ok');
