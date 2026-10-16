"""Shared base class for the organizer's tests."""
import unittest

import movie_renamer as m


class OrganizerTestCase(unittest.TestCase):
    """Every test starts with no remembered OMDb failure, back-off or cached title.

    OMDb state is process-wide on purpose (a real outage should be remembered between
    releases), so without this one test's simulated outage would make the next test see
    "OMDb is down". run() is overridden, not setUp, so subclasses that define their own
    setUp cannot forget to reset."""

    def run(self, result=None):
        m.reset_omdb_state()
        return super().run(result)
