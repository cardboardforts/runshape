import asyncio

from shop.domain import Order


class OrderService:
    def __init__(self, repository):
        self.repository = repository

    def place_order(self, items):
        if not items:
            return None
        order = Order(items)
        self.repository.save(order)
        return order

    async def place_order_later(self, items):
        await asyncio.sleep(0)
        return self.place_order(items)

    async def place_order_in_worker_thread(self, items):
        return await asyncio.to_thread(self.place_order, items)
