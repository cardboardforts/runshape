from shop.adapters import SqlOrderRepository
from shop.service import OrderService


def compose(db):
    return OrderService(SqlOrderRepository(db))
