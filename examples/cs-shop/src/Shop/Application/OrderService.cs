using Shop.Domain;

namespace Shop.Application;

/// <summary>The outcome of placing an order: the order, or every reason it was refused.</summary>
public sealed record Placement(Order Order, bool Valid, IReadOnlyList<string> Problems);

/// <summary>Places and looks up orders.</summary>
public sealed class OrderService(IOrderRepository repository)
{
    /// <summary>Validates and stores an order. A refused order isn't an exception: it's a Placement with its problems.</summary>
    public Placement Place(Order order)
    {
        var problems = order.Problems();
        if (problems.Count > 0) return new Placement(order, false, problems);
        order.Placed($"ord-{repository.Count() + 1}");
        repository.Save(order);
        return new Placement(order, true, []);
    }

    public Order? Get(string id) => repository.Find(id);
}
