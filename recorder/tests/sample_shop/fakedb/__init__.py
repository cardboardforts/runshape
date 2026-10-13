"""Stands in for a database driver. Configured in pytest.ini so only execute() is traffic:
not is_closed() (housekeeping) and not _send() (called from inside execute())."""


class FakeDb:
    def __init__(self):
        self.rows = []

    def execute(self, sql, *params):
        return self._send(sql, params)

    def is_closed(self):
        return False

    def _send(self, sql, params):
        self.rows.append(params)
        return len(self.rows)
