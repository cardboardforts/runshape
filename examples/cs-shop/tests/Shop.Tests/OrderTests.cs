using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Shop.Application;
using Shop.Domain;
using Shop.Storage;
using Xunit;

namespace Shop.Tests;

public class OrderTests
{
    [Fact]
    public void Total_adds_every_line()
    {
        var order = new Order("ada", [new OrderLine("tea", 2, 350), new OrderLine("cup", 1, 900)]);
        Assert.Equal(1600, order.TotalCents());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(101)]
    public void A_quantity_out_of_range_is_a_problem(int quantity)
    {
        var order = new Order("ada", [new OrderLine("tea", quantity, 350)]);
        Assert.Equal(["line 0: quantity must be 1 to 100"], order.Problems());
    }
}

/// <summary>The service over a real SQLite database (in memory, one per test).</summary>
public sealed class OrderServiceTests : IDisposable
{
    private readonly SqliteConnection _connection = new("Data Source=:memory:");
    private readonly ShopDbContext _db;
    private readonly OrderService _service;

    public OrderServiceTests()
    {
        _connection.Open();
        _db = new ShopDbContext(new DbContextOptionsBuilder<ShopDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _service = new OrderService(new SqliteOrderRepository(_db));
    }

    [Fact]
    public void A_placed_order_can_be_found_again()
    {
        var placement = _service.Place(new Order("ada", [new OrderLine("tea", 2, 350)]));

        Assert.True(placement.Valid);
        var found = _service.Get(placement.Order.Id!);
        Assert.NotNull(found);
        Assert.Equal(700, found.TotalCents());
    }

    [Fact]
    public void A_refused_order_lists_every_problem_and_is_not_stored()
    {
        var placement = _service.Place(new Order("", []));

        Assert.False(placement.Valid);
        Assert.Equal(["customer is required", "an order needs at least one line"], placement.Problems);
        Assert.Null(_service.Get("ord-1"));
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }
}
