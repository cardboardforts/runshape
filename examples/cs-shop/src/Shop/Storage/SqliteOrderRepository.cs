using Microsoft.EntityFrameworkCore;
using Shop.Domain;

namespace Shop.Storage;

/// <summary>An order as a row: the domain's Order stays free of EF's needs.</summary>
public sealed class OrderRow
{
    public string Id { get; set; } = "";
    public string Customer { get; set; } = "";
    public List<LineRow> Lines { get; set; } = [];
}

public sealed class LineRow
{
    public int Id { get; set; }
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
    public int PriceCents { get; set; }
}

public sealed class ShopDbContext(DbContextOptions<ShopDbContext> options) : DbContext(options)
{
    public DbSet<OrderRow> Orders => Set<OrderRow>();
}

/// <summary>Orders in SQLite, through EF Core.</summary>
public sealed class SqliteOrderRepository(ShopDbContext db) : IOrderRepository
{
    public void Save(Order order)
    {
        var row = new OrderRow { Id = order.Id!, Customer = order.Customer };
        foreach (var line in order.Lines)
        {
            row.Lines.Add(new LineRow { Sku = line.Sku, Quantity = line.Quantity, PriceCents = line.PriceCents });
        }
        db.Orders.Add(row);
        db.SaveChanges();
    }

    public Order? Find(string id)
    {
        var row = db.Orders.Include(o => o.Lines).AsNoTracking().SingleOrDefault(o => o.Id == id);
        if (row is null) return null;
        var order = new Order(row.Customer, row.Lines.Select(l => new OrderLine(l.Sku, l.Quantity, l.PriceCents)).ToList());
        order.Placed(row.Id);
        return order;
    }

    public int Count() => db.Orders.Count();
}
