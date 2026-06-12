async function testOmdb() {
  const showImdbId = 'tt9813792'; // From
  const season = 1;
  const keys = ['thewdb', '6c5cf212', '5d5a7d3c'];
  
  for (const key of keys) {
    const url = `https://www.omdbapi.com/?i=${showImdbId}&Season=${season}&apikey=${key}`;
    console.log(`Trying OMDb with key "${key}": ${url}`);
    try {
      const res = await fetch(url);
      console.log(`Status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        if (data.Response === 'True') {
          console.log(`Success! Found ${data.Episodes?.length} episodes.`);
          console.log(`First episode:`, data.Episodes?.[0]);
          return;
        } else {
          console.log(`OMDb error response:`, data.Error);
        }
      }
    } catch (e) {
      console.error(`Error with key "${key}":`, e.message);
    }
  }
}

testOmdb();
