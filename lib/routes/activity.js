// "Who's on": the header counter and panel (lib/activity.js builds the snapshot).
module.exports = function registerActivityRoutes(app, { requirePermission, activity }) {
  app.get('/api/activity', requirePermission('canActivity'), async (_req, res) => {
    res.json(await activity.snapshot());
  });
};
