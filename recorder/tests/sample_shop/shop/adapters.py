from shop.domain import OrderRepository


class SqlOrderRepository(OrderRepository):
    def __init__(self, db):
        self.db = db

    def save(self, order):
        if self.db.is_closed():
            raise ConnectionError("database connection is closed")
        return self.db.execute("INSERT INTO orders (total) VALUES (?)", order.total())
