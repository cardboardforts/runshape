namespace Shop.Domain;

/// <summary>One line of an order. Prices are in cents, so totals never round.</summary>
public sealed record OrderLine(string Sku, int Quantity, int PriceCents)
{
    public int TotalCents => Quantity * PriceCents;
}

/// <summary>What a customer placed.</summary>
public sealed class Order
{
    /// <summary>The most of one SKU a single order may hold.</summary>
    public const int MaxQuantity = 100;

    public Order(string customer, IReadOnlyList<OrderLine> lines)
    {
        Customer = customer;
        Lines = lines;
    }

    public string? Id { get; private set; }
    public string Customer { get; }
    public IReadOnlyList<OrderLine> Lines { get; }

    public int TotalCents()
    {
        var total = 0;
        foreach (var line in Lines)
        {
            total += line.TotalCents;
        }
        return total;
    }

    /// <summary>Everything wrong with the order, not just the first thing.</summary>
    public List<string> Problems()
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(Customer)) problems.Add("customer is required");
        if (Lines.Count == 0) problems.Add("an order needs at least one line");
        for (var i = 0; i < Lines.Count; i++)
        {
            var line = Lines[i];
            if (line.Quantity < 1 || line.Quantity > MaxQuantity) problems.Add($"line {i}: quantity must be 1 to {MaxQuantity}");
            if (line.PriceCents < 0) problems.Add($"line {i}: price can't be negative");
        }
        return problems;
    }

    public void Placed(string id) => Id = id;
}
