fetch(`https://www.omdbapi.com/?t=From&apikey=thewdb`)
  .then(res => res.json())
  .then(console.log)
  .catch(console.error);
