// Film collections for the app (lib/collections.js does the Wikidata lookup and
// grouping). Registered by server.js; it returns the refresh that server.js runs
// on a timer.
module.exports = function registerCollectionRoutes(app, {
  requireAuth, scanLibrary, getMetadataForItem, libraryVersion, metadataRevision = () => '', collections,
}) {
  const boot = Date.now().toString(36);
  const films = () => scanLibrary()
    .filter(item => (item.mediaKind || item.type) === 'movie' && !item.showName)
    .map(item => ({ id: item.id, imdbID: getMetadataForItem(item)?.imdbID, year: item.year }))
    .filter(film => film.imdbID);

  app.get('/api/collections', requireAuth, (req, res) => {
    res.set({ ETag: `W/"collections-${boot}-${libraryVersion()}-${metadataRevision()}-${collections.revision}"`, 'Cache-Control': 'private, no-cache' });
    if (req.fresh) return res.status(304).end();
    res.json({ ok: true, collections: collections.build(films()) });
  });

  return { refreshCollections: () => collections.refresh(films().map(f => f.imdbID), { budget: 600 }) };
};
