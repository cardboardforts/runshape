namespace Shop.Domain;

/// <summary>The port orders are stored through; Storage implements it.</summary>
public interface IOrderRepository
{
    void Save(Order order);
    Order? Find(string id);
    int Count();
}
