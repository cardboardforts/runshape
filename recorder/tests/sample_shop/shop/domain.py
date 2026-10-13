import abc

BULK_DISCOUNT_THRESHOLD = 10


class Order:
    def __init__(self, items):
        self.items = list(items)

    def total(self):
        subtotal = sum(self.items)
        if subtotal >= BULK_DISCOUNT_THRESHOLD:
            return subtotal - 1
        return subtotal


class OrderRepository(abc.ABC):
    @abc.abstractmethod
    def save(self, order):
        ...
