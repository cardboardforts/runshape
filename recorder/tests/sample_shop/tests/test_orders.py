import asyncio

import pytest
from fakedb import FakeDb
from shop.main import compose


def test_place_order():
    db = FakeDb()
    service = compose(db)
    order = service.place_order([4, 7])
    assert order.total() == 10
    assert db.execute("SELECT count(*) FROM orders") == 2


def test_rejects_empty_order():
    service = compose(FakeDb())
    assert service.place_order([]) is None


def test_place_order_later():
    service = compose(FakeDb())
    order = asyncio.run(service.place_order_later([1]))
    assert order.total() == 1


def test_place_order_in_worker_thread():
    service = compose(FakeDb())
    order = asyncio.run(service.place_order_in_worker_thread([2]))
    assert order.total() == 2


@pytest.mark.xfail(strict=True, reason="known bug: negative quantities are accepted")
def test_rejects_negative_items():
    service = compose(FakeDb())
    assert service.place_order([-1]) is None
